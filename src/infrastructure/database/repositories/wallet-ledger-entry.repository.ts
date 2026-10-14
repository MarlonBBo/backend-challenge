import type { EntityManager } from '@mikro-orm/postgresql';

import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper';

export class WalletLedgerEntryRepository {
  async insert(entityManager: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    await entityManager.persist(WalletLedgerEntryMapper.toEntity(entry)).flush();
  }
}
