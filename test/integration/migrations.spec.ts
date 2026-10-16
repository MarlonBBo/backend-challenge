import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletEntity } from '../../src/infrastructure/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/database/entities/wager-transaction.entity';
import { InboxMessageEntity } from '../../src/infrastructure/database/entities/inbox-message.entity';
import { OutboxMessageEntity } from '../../src/infrastructure/database/entities/outbox-message.entity';
import { Migration20261014000100 } from '../../src/infrastructure/database/migrations/Migration20261014000100';

const databaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
test.skipIf(databaseUrl === undefined)(
  'empty isolated schema supports migration up/down/up',
  async () => {
    if (!new URL(databaseUrl!).pathname.endsWith('_migration_test'))
      throw new Error('Migration database must end in _migration_test');
    const orm = await MikroORM.init({
      clientUrl: databaseUrl,
      entities: [
        WalletEntity,
        WalletLedgerEntryEntity,
        WagerTransactionEntity,
        InboxMessageEntity,
        OutboxMessageEntity,
      ],
      extensions: [Migrator],
      migrations: { migrationsList: [Migration20261014000100] },
    });
    try {
      const em = orm.em.fork();
      // Never roll back a database containing fixture/user data, even with the required name.
      const existing = await em.execute<{ tablename: string }[]>(
        "select tablename from pg_tables where schemaname = 'public' and tablename <> 'mikro_orm_migrations'",
      );
      const allowed = new Set([
        'wallets',
        'wager_transactions',
        'wallet_ledger_entries',
        'inbox_messages',
        'outbox_messages',
      ]);
      for (const { tablename } of existing) {
        if (!allowed.has(tablename)) throw new Error('Unexpected table: refusing rollback');
        const rows = await em.execute<unknown[]>(`select 1 from "${tablename}" limit 1`);
        if (rows.length !== 0) throw new Error('Database contains data: refusing rollback');
      }
      await orm.getMigrator().up();
      expect(
        await em
          .getConnection()
          .execute("select 1 from pg_trigger where tgname = 'wallet_ledger_entries_immutable'"),
      ).toHaveLength(1);
      await orm.getMigrator().down();
      const removed = await em.execute<{ relation: string | null }[]>(
        "select to_regclass('public.wallets')::text as relation",
      );
      expect(removed[0]?.relation).toBeNull();
      await orm.getMigrator().up();
      expect(
        await em.execute(
          "select 1 from pg_trigger where tgname = 'wallet_ledger_entries_immutable'",
        ),
      ).toHaveLength(1);
      expect(await orm.getMigrator().getPendingMigrations()).toHaveLength(0);
    } finally {
      await orm.close(true);
    }
  },
  30_000,
);
