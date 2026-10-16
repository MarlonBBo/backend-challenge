import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type {
  WalletReconciliationReader,
  WalletReconciliationSnapshot,
} from '../../../application/wallet/ports/wallet-reconciliation-reader';

@Injectable()
export class MikroOrmWalletReconciliationReader implements WalletReconciliationReader {
  constructor(@Inject(EntityManager) private readonly entityManager: EntityManager) {}
  async read(walletId: string): Promise<WalletReconciliationSnapshot | undefined> {
    // Uma instrução SQL utiliza um único snapshot MVCC para a carteira (wallet) 
    // e o registro (ledger), mesmo durante commits concorrentes.
    const rows = await this.entityManager.fork().execute<
      {
        wallet_id: string;
        currency: string;
        stored_balance: string;
        calculated_balance: string;
        difference: string;
        consistent: boolean;
        checked_entries: number;
        currency_mismatch_entries: number;
        checked_at: Date | string;
      }[]
    >(
      `with snapshot as (
      select w.id, w.currency, w.balance,
        coalesce(sum(case when l.currency = w.currency then case when l.direction = 'CREDIT' then l.amount else -l.amount end else 0.00 end), 0.00) as calculated,
        count(l.id)::int as entries,
        count(l.id) filter (where l.currency <> w.currency)::int as mismatches
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id
    ) select id as wallet_id, currency, balance::text as stored_balance, calculated::text as calculated_balance,
      (balance - calculated)::text as difference, (balance = calculated and mismatches = 0) as consistent,
      entries as checked_entries, mismatches as currency_mismatch_entries, statement_timestamp() as checked_at
      from snapshot`,
      [walletId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      walletId: row.wallet_id,
      currency: row.currency,
      storedBalance: row.stored_balance,
      calculatedBalance: row.calculated_balance,
      difference: row.difference,
      consistent: row.consistent,
      checkedEntries: row.checked_entries,
      currencyMismatchEntries: row.currency_mismatch_entries,
      checkedAt: new Date(row.checked_at).toISOString(),
    };
  }
}
