import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import {
  ConcurrentIdempotencyError,
  ConcurrentExternalTransactionError,
  type WageringTransactionContext,
  type WageringUnitOfWork,
} from '../../../application/wagering/ports/wagering-unit-of-work';
import { OutboxMessageRepository } from '../repositories/outbox-message.repository';
import { WagerTransactionRepository } from '../repositories/wager-transaction.repository';
import { WalletLedgerEntryRepository } from '../repositories/wallet-ledger-entry.repository';
import { WalletRepository } from '../repositories/wallet.repository';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import type { Wallet } from '../../../domain/wallet/wallet';
import { InboxMessageRepository } from '../repositories/inbox-message.repository';

@Injectable()
export class MikroOrmWageringUnitOfWork implements WageringUnitOfWork {
  private readonly wallets = new WalletRepository();
  private readonly transactions = new WagerTransactionRepository();
  private readonly ledger = new WalletLedgerEntryRepository();
  private readonly outbox = new OutboxMessageRepository();
  private readonly inbox = new InboxMessageRepository();

  constructor(private readonly entityManager: EntityManager) {}

  async execute<T>(work: (context: WageringTransactionContext) => Promise<T>): Promise<T> {
    try {
      return await this.entityManager
        .fork()
        .transactional(async (transactionalEntityManager) =>
          work(this.context(transactionalEntityManager)),
        );
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        if (error.message.includes('wager_transactions_idempotency_key_unique')) {
          throw new ConcurrentIdempotencyError();
        }

        if (error.message.includes('wager_transactions_provider_external_unique')) {
          throw new ConcurrentExternalTransactionError();
        }
      }

      throw error;
    }
  }

  executeNextPending<T>(
    now: Date,
    work: (
      context: WageringTransactionContext,
      transaction: WagerTransaction,
      wallet: Wallet,
    ) => Promise<T>,
  ): Promise<T | undefined> {
    return this.entityManager.fork().transactional(async (entityManager) => {
      const transaction = await this.transactions.findNextPendingForUpdate(entityManager, now);
      if (transaction === undefined) {
        return undefined;
      }
      const wallet = await this.wallets.findByIdForUpdate(entityManager, transaction.walletId);
      if (wallet === undefined) {
        throw new Error(`Wallet ${transaction.walletId} missing for pending transaction`);
      }
      return work(this.context(entityManager), transaction, wallet);
    });
  }

  private context(transactionalEntityManager: EntityManager): WageringTransactionContext {
    return {
      receiveInbox: (delivery) => this.inbox.receive(transactionalEntityManager, delivery),
      completeInbox: (message) => this.inbox.complete(transactionalEntityManager, message),
      findTransactionByIdempotencyKey: (idempotencyKey) =>
        this.transactions.findByIdempotencyKey(transactionalEntityManager, idempotencyKey),
      findTransactionByExternalId: (providerId, externalTransactionId) =>
        this.transactions.findByExternalId(
          transactionalEntityManager,
          providerId,
          externalTransactionId,
        ),
      findProcessedReversal: (referenceTransactionId, kind) =>
        this.transactions.findProcessedReversal(
          transactionalEntityManager,
          referenceTransactionId,
          kind,
        ),
      lockWallet: (walletId) =>
        this.wallets.findByIdForUpdate(transactionalEntityManager, walletId),
      insertTransaction: (transaction) =>
        this.transactions.insert(transactionalEntityManager, transaction),
      updateTransaction: (transaction) =>
        this.transactions.update(transactionalEntityManager, transaction),
      updateWallet: (wallet) => this.wallets.update(transactionalEntityManager, wallet),
      insertLedgerEntry: (entry) => this.ledger.insert(transactionalEntityManager, entry),
      insertOutboxMessages: (messages) =>
        this.outbox.insertMany(transactionalEntityManager, messages),
    };
  }
}
