import type { EntityManager } from '@mikro-orm/postgresql';

import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper';
import type {
  LedgerEntryView,
  LedgerPosition,
} from '../../../application/wallet/ports/wallet-ledger-reader';
import type { LedgerDirection } from '../../../domain/ledger/ledger-direction';

export class WalletLedgerEntryRepository {
  async findPage(
    entityManager: EntityManager,
    walletId: string,
    take: number,
    after?: LedgerPosition,
  ): Promise<readonly LedgerEntryView[]> {
    const rows = await entityManager.execute<
      {
        id: string;
        transaction_id: string;
        direction: LedgerDirection;
        amount: string;
        currency: string;
        balance_before: string;
        balance_after: string;
        created_at: string;
      }[]
    >(
      `
      select id, transaction_id, direction, amount, currency, balance_before, balance_after,
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
      from wallet_ledger_entries
      where wallet_id = ?
        ${after === undefined ? '' : 'and (created_at, id) < (?::timestamptz, ?::uuid)'}
      order by wallet_ledger_entries.created_at desc, id desc
      limit ?
    `,
      after === undefined ? [walletId, take] : [walletId, after.createdAt, after.id, take],
    );
    return rows.map((row) =>
      Object.freeze({
        id: row.id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: Object.freeze({ amount: row.amount, currency: row.currency }),
        balanceBefore: Object.freeze({ amount: row.balance_before, currency: row.currency }),
        balanceAfter: Object.freeze({ amount: row.balance_after, currency: row.currency }),
        createdAt: row.created_at,
      }),
    );
  }

  async insert(entityManager: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    await entityManager.persist(WalletLedgerEntryMapper.toEntity(entry)).flush();
  }
}
