import { Injectable } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';

import {
  type CreateWalletPersistenceBundle,
  type CreateWalletUnitOfWork,
  WalletAlreadyExistsError,
} from '../../../application/wallet/ports/create-wallet-unit-of-work';
import { OutboxMessageRepository } from '../repositories/outbox-message.repository';
import { WagerTransactionRepository } from '../repositories/wager-transaction.repository';
import { WalletLedgerEntryRepository } from '../repositories/wallet-ledger-entry.repository';
import { WalletRepository } from '../repositories/wallet.repository';

@Injectable()
export class MikroOrmCreateWalletUnitOfWork implements CreateWalletUnitOfWork {
  private readonly wallets = new WalletRepository();
  private readonly transactions = new WagerTransactionRepository();
  private readonly ledger = new WalletLedgerEntryRepository();
  private readonly outbox = new OutboxMessageRepository();

  constructor(private readonly entityManager: EntityManager) {}

  async create(bundle: CreateWalletPersistenceBundle): Promise<void> {
    try {
      await this.entityManager.transactional(async (transactionalEntityManager) => {
        await this.wallets.insert(transactionalEntityManager, bundle.wallet);

        if (bundle.openingTransaction !== undefined) {
          await this.transactions.insert(transactionalEntityManager, bundle.openingTransaction);
        }

        if (bundle.openingLedgerEntry !== undefined) {
          await this.ledger.insert(transactionalEntityManager, bundle.openingLedgerEntry);
        }

        await this.outbox.insertMany(transactionalEntityManager, bundle.outboxMessages);
      });
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        error.message.includes('wallets_player_currency_unique')
      ) {
        throw new WalletAlreadyExistsError(bundle.wallet.playerId, bundle.wallet.currency);
      }

      throw error;
    }
  }
}
