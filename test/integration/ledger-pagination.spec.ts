import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletLedgerController } from '../../src/presentation/http/wallet-ledger.controller';
import {
  GetWalletLedgerUseCase,
  type GetWalletLedgerResult,
} from '../../src/application/wallet/get-wallet-ledger.use-case';
import { MikroOrmWalletReader } from '../../src/infrastructure/database/queries/mikro-orm-wallet.reader';
import { MikroOrmWalletLedgerReader } from '../../src/infrastructure/database/queries/mikro-orm-wallet-ledger.reader';
import { WalletEntity } from '../../src/infrastructure/database/entities/wallet.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/database/entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.entity';
import { InboxMessageEntity } from '../../src/infrastructure/database/entities/inbox-message.entity';
import { OutboxMessageEntity } from '../../src/infrastructure/database/entities/outbox-message.entity';
import { Migration20261014000100 } from '../../src/infrastructure/database/migrations/Migration20261014000100';
import { WalletRepository } from '../../src/infrastructure/database/repositories/wallet.repository';
import { WagerTransactionRepository } from '../../src/infrastructure/database/repositories/wager-transaction.repository';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import { MikroOrmWageringUnitOfWork } from '../../src/infrastructure/database/unit-of-work/mikro-orm-wagering.unit-of-work';
import { Wallet } from '../../src/domain/wallet/wallet';
import { Money } from '../../src/domain/shared/value-objects/money';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wagering/wager-transaction';

const databaseUrl = process.env.TEST_DATABASE_URL;
const timestamps = [
  '2026-10-14T12:00:00.122999Z',
  '2026-10-14T12:00:00.123001Z',
  '2026-10-14T12:00:00.123455Z',
  '2026-10-14T12:00:00.123456Z',
  '2026-10-14T12:00:00.123456Z',
];

describe.skipIf(databaseUrl === undefined)(
  'Ledger cursor pagination with PostgreSQL and HTTP',
  () => {
    let orm: MikroORM;
    let app: INestApplication;
    let baseUrl: string;
    let seeded: Awaited<ReturnType<typeof seed>>;

    beforeAll(async () => {
      if (!new URL(databaseUrl!).pathname.endsWith('_test'))
        throw new Error('TEST_DATABASE_URL must end in _test');
      orm = await MikroORM.init({
        clientUrl: databaseUrl,
        entities: [
          WalletEntity,
          WagerTransactionEntity,
          WalletLedgerEntryEntity,
          InboxMessageEntity,
          OutboxMessageEntity,
        ],
        extensions: [Migrator],
        migrations: { migrationsList: [Migration20261014000100] },
        pool: { min: 0, max: 10 },
      });
      await orm.getMigrator().up();
      const module = await Test.createTestingModule({
        controllers: [WalletLedgerController],
        providers: [
          {
            provide: GetWalletLedgerUseCase,
            useValue: new GetWalletLedgerUseCase(
              new MikroOrmWalletReader(orm.em),
              new MikroOrmWalletLedgerReader(orm.em),
            ),
          },
        ],
      }).compile();
      app = module.createNestApplication();
      app.useLogger(false);
      app.setGlobalPrefix('api');
      await app.listen(0, '127.0.0.1');
      baseUrl = `${await app.getUrl()}/api`;
      seeded = await seed();
    }, 30_000);

    afterAll(async () => {
      if (app !== undefined) await app.close();
      if (orm !== undefined) await orm.close(true);
    }, 10_000);

    async function seed(count = 5) {
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId: randomUUID(),
        initialBalance: Money.zero('BRL'),
        createdAt: new Date('2026-10-14T12:00:00Z'),
      });
      const prefix = randomUUID().slice(0, 24);
      const ordinal = [7, 8, 9, 1, 5];
      const records = timestamps.slice(0, count).map((timestamp, index) => {
        const money = Money.from({ amount: '1.00', currency: 'BRL' });
        const change = wallet.credit(money, new Date(timestamp));
        const transaction = WagerTransaction.create({
          id: randomUUID(),
          providerId: 'ledger-fixture',
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          payloadHash: 'a'.repeat(64),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'round',
          gameId: 'game',
          kind: WagerTransactionKind.Win,
          money,
          createdAt: new Date(timestamp),
        });
        transaction.markProcessed(undefined, new Date(timestamp), wallet.balance);
        return {
          id: `${prefix}${String(ordinal[index]).padStart(12, '0')}`,
          timestamp,
          change,
          transaction,
        };
      });
      await orm.em.fork().transactional(async (em) => {
        await new WalletRepository().insert(em, wallet);
        for (const record of records) {
          await new WagerTransactionRepository().insert(em, record.transaction);
          // Insert exact microseconds from the fixture; Date cannot represent these.
          // No UPDATE or DELETE of the immutable ledger is used.
          await em.execute(
            `insert into wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
          values (?, ?, ?, 'CREDIT', '1.00', 'BRL', ?, ?, ?::timestamptz)`,
            [
              record.id,
              wallet.id,
              record.transaction.id,
              record.change.balanceBefore.toJSON().amount,
              record.change.balanceAfter.toJSON().amount,
              record.timestamp,
            ],
          );
        }
      });
      return {
        wallet,
        expectedIds: records
          .slice()
          .reverse()
          .map((record) => record.id),
      };
    }

    async function page(walletId: string, query = '') {
      const response = await fetch(`${baseUrl}/wallets/${walletId}/ledger${query}`);
      return { response, body: (await response.json()) as GetWalletLedgerResult };
    }

    async function remaining(walletId: string, cursor: string | null, limit: number) {
      const ids: string[] = [];
      for (let step = 0; cursor !== null && step < 10; step += 1) {
        const result = await page(walletId, `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`);
        expect(result.response.status).toBe(200);
        ids.push(...result.body.items.map((item) => item.id));
        cursor = result.body.nextCursor;
      }
      expect(cursor).toBeNull();
      return ids;
    }

    test('paginates without duplicates or omissions across equal timestamps and distinct microseconds', async () => {
      for (const limit of [1, 2]) {
        const first = await page(seeded.wallet.id, `?limit=${limit}`);
        expect(first.response.status).toBe(200);
        expect(first.body.items[0]?.createdAt).toBe('2026-10-14T12:00:00.123456Z');
        const ids = [
          ...first.body.items.map((item) => item.id),
          ...(await remaining(seeded.wallet.id, first.body.nextCursor, limit)),
        ];
        expect(ids).toEqual(seeded.expectedIds);
        expect(new Set(ids).size).toBe(5);
      }
    });

    test('returns full movement data, defaults to 50 and has no phantom final page', async () => {
      for (const query of ['', '?limit=5', '?limit=100']) {
        const result = await page(seeded.wallet.id, query);
        expect(result.response.status).toBe(200);
        expect(result.body.walletId).toBe(seeded.wallet.id);
        expect(result.body.items).toHaveLength(5);
        expect(result.body.nextCursor).toBeNull();
        expect(result.body.items[0]).toMatchObject({
          direction: 'CREDIT',
          money: { amount: '1.00', currency: 'BRL' },
          balanceBefore: { amount: '4.00', currency: 'BRL' },
          balanceAfter: { amount: '5.00', currency: 'BRL' },
        });
      }
    });

    test('distinguishes empty wallets from missing wallets and rejects a cursor from another wallet', async () => {
      const empty = await seed(0);
      expect((await page(empty.wallet.id)).body).toEqual({
        walletId: empty.wallet.id,
        items: [],
        nextCursor: null,
      });
      expect((await page(randomUUID())).response.status).toBe(404);
      const first = await page(seeded.wallet.id, '?limit=1');
      const other = await page(empty.wallet.id, `?cursor=${first.body.nextCursor}`);
      expect(other.response.status).toBe(400);
      expect(other.body).toMatchObject({ code: 'INVALID_CURSOR' });
      expect(
        (await page(seeded.wallet.id.toUpperCase(), `?cursor=${first.body.nextCursor}`)).response
          .status,
      ).toBe(200);
    });

    test('rejects invalid limits, repeated query parameters, malformed cursors and invalid wallet IDs', async () => {
      for (const value of ['0', '-1', '101', '1.5', '01', '1e2', '']) {
        const result = await page(seeded.wallet.id, `?limit=${value}`);
        expect(result.response.status).toBe(400);
        expect(result.body).toMatchObject({ code: 'INVALID_PAGINATION' });
      }
      for (const query of [
        '?limit=1&limit=2',
        '?cursor=a&cursor=b',
        '?cursor=not-a-cursor',
        '?cursor=e30',
        '?cursor=',
      ])
        expect((await page(seeded.wallet.id, query)).response.status).toBe(400);
      expect((await page('not-a-uuid')).response.status).toBe(400);
    });

    test('GET changes neither wallet nor transaction, ledger or outbox records', async () => {
      const em = orm.em.fork();
      const before = {
        ledger: await em.count(WalletLedgerEntryEntity, { walletId: seeded.wallet.id }),
        transactions: await em.count(WagerTransactionEntity, { walletId: seeded.wallet.id }),
        outbox: await em.count(OutboxMessageEntity, {}),
      };
      const result = await page(seeded.wallet.id, '?limit=2');
      await remaining(seeded.wallet.id, result.body.nextCursor, 2);
      expect(await em.count(WalletLedgerEntryEntity, { walletId: seeded.wallet.id })).toBe(
        before.ledger,
      );
      expect(await em.count(WagerTransactionEntity, { walletId: seeded.wallet.id })).toBe(
        before.transactions,
      );
      expect(await em.count(OutboxMessageEntity, {})).toBe(before.outbox);
      const wallet = await new MikroOrmWalletReader(orm.em).findById(seeded.wallet.id);
      expect(wallet?.balance.toJSON().amount).toBe('5.00');
      expect(wallet?.version).toBe(6);
    });

    test('a newer insertion does not shift the continuation or repeat existing entries', async () => {
      const fixture = await seed();
      const first = await page(fixture.wallet.id, '?limit=2');
      await new ProcessWagerTransactionUseCase(new MikroOrmWageringUnitOfWork(orm.em)).execute({
        providerId: 'ledger-newer',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        walletId: fixture.wallet.id,
        playerId: fixture.wallet.playerId,
        roundId: 'round',
        gameId: 'game',
        kind: WagerTransactionKind.Win,
        money: { amount: '1.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });
      expect([
        ...first.body.items.map((item) => item.id),
        ...(await remaining(fixture.wallet.id, first.body.nextCursor, 2)),
      ]).toEqual(fixture.expectedIds);
      expect((await page(fixture.wallet.id)).body.items).toHaveLength(6);
      const rows = await orm.em
        .fork()
        .execute<{ balance: string; reconstructed: string }[]>(
          `select w.balance, sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end)::numeric(20,2) as reconstructed from wallets w join wallet_ledger_entries l on l.wallet_id = w.id where w.id = ? group by w.id`,
          [fixture.wallet.id],
        );
      expect(rows[0]).toEqual({ balance: '6.00', reconstructed: '6.00' });
    });
  },
);
