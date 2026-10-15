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

@Injectable()
export class MikroOrmWageringUnitOfWork implements WageringUnitOfWork {
  private readonly wallets = new WalletRepository();
  private readonly transactions = new WagerTransactionRepository();
  private readonly ledger = new WalletLedgerEntryRepository();
  private readonly outbox = new OutboxMessageRepository();

  constructor(private readonly entityManager: EntityManager) {}

  async execute<T>(work: (context: WageringTransactionContext) => Promise<T>): Promise<T> {
    try {
      return await this.entityManager.transactional(async (transactionalEntityManager) =>
        work({
          findTransactionByIdempotencyKey: (idempotencyKey) =>
            this.transactions.findByIdempotencyKey(transactionalEntityManager, idempotencyKey),
          findTransactionByExternalId: (providerId, externalTransactionId) =>
            this.transactions.findByExternalId(
              transactionalEntityManager,
              providerId,
              externalTransactionId,
            ),
          lockWallet: (walletId) =>
            this.wallets.findByIdForUpdate(transactionalEntityManager, walletId),
          insertTransaction: (transaction) =>
            this.transactions.insert(transactionalEntityManager, transaction),
          updateWallet: (wallet) => this.wallets.update(transactionalEntityManager, wallet),
          insertLedgerEntry: (entry) => this.ledger.insert(transactionalEntityManager, entry),
          insertOutboxMessages: (messages) =>
            this.outbox.insertMany(transactionalEntityManager, messages),
        }),
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
}
