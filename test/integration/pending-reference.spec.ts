import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionCommand,
} from '../../src/application/wagering/process-wager-transaction.use-case';
import { CreateWalletUseCase } from '../../src/application/wallet/create-wallet.use-case';
import { ReferenceRetryPolicy } from '../../src/application/wagering/reference-retry-policy';
import type { WageringUnitOfWork } from '../../src/application/wagering/ports/wagering-unit-of-work';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { InboxMessageEntity } from '../../src/infrastructure/database/entities/inbox-message.entity';
import { OutboxMessageEntity } from '../../src/infrastructure/database/entities/outbox-message.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/database/entities/wager-transaction.entity';
import { WalletEntity } from '../../src/infrastructure/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.entity';
import { Migration20261014000100 } from '../../src/infrastructure/database/migrations/Migration20261014000100';
import { MikroOrmWageringUnitOfWork } from '../../src/infrastructure/database/unit-of-work/mikro-orm-wagering.unit-of-work';
import { MikroOrmCreateWalletUnitOfWork } from '../../src/infrastructure/database/unit-of-work/mikro-orm-create-wallet.unit-of-work';
import { PendingReferenceWorker } from '../../src/infrastructure/workers/pending-reference.worker';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)('Pending references with PostgreSQL', () => {
  let orm: MikroORM;
  let unitOfWork: MikroOrmWageringUnitOfWork;
  let processor: ProcessWagerTransactionUseCase;

  beforeAll(async () => {
    // Require a separate test database; never migrate the development database here.
    if (!new URL(databaseUrl!).pathname.endsWith('_test'))
      throw new Error('TEST_DATABASE_URL must point to a database ending in _test');
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
    unitOfWork = new MikroOrmWageringUnitOfWork(orm.em);
    processor = new ProcessWagerTransactionUseCase(unitOfWork);
  });

  afterAll(async () => {
    if (orm !== undefined) await orm.close(true);
  });

  async function fixture(
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback = WagerTransactionKind.Refund,
  ) {
    const playerId = randomUUID();
    const wallet = await new CreateWalletUseCase(
      new MikroOrmCreateWalletUnitOfWork(orm.em.fork()),
    ).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: randomUUID(),
    });
    const providerId = `integration-${randomUUID()}`;
    const bet: ProcessWagerTransactionCommand = {
      providerId,
      externalTransactionId: 'bet',
      idempotencyKey: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: 'round',
      gameId: 'game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      correlationId: randomUUID(),
    };
    const reversal: ProcessWagerTransactionCommand = {
      ...bet,
      externalTransactionId: 'reversal',
      idempotencyKey: randomUUID(),
      kind,
      referenceExternalTransactionId: 'bet',
    };
    return { wallet, bet, reversal };
  }

  async function reconcile(walletId: string, expectedBalance: string) {
    const rows = await orm.em.fork().execute<{ balance: string; reconstructed: string }[]>(
      `
      select w.balance, coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2) as reconstructed
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id
    `,
      [walletId],
    );
    expect(rows[0]?.balance).toBe(expectedBalance);
    expect(rows[0]?.reconstructed).toBe(expectedBalance);
  }

  test('two concurrent workers process an out-of-order REFUND only once', async () => {
    const { wallet, bet, reversal } = await fixture();
    const pending = await processor.execute(reversal);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    await processor.execute(bet);
    const due = new Date(Date.now() + 10_000);
    const results = await Promise.all([
      processor.reprocessNextPending(due),
      processor.reprocessNextPending(due),
    ]);
    expect(
      results.filter(
        (result) =>
          result?.transactionId === pending.transactionId &&
          result.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);
    const em = orm.em.fork();
    expect(await em.count(WalletLedgerEntryEntity, { transactionId: pending.transactionId })).toBe(
      1,
    );
    expect(
      await em.count(OutboxMessageEntity, {
        aggregateId: pending.transactionId,
        eventType: 'WagerTransactionProcessed',
      }),
    ).toBe(1);
    expect((await processor.execute(reversal)).idempotentReplay).toBe(true);
    expect(await processor.reprocessNextPending(due)).toBeUndefined();
    await reconcile(wallet.id, '100.00');
  });

  test('failure before outbox insertion rolls back transaction, wallet and ledger, then retries safely', async () => {
    const { wallet, bet, reversal } = await fixture(WagerTransactionKind.Rollback);
    const pending = await processor.execute(reversal);
    await processor.execute(bet);
    const failingUnitOfWork: WageringUnitOfWork = {
      execute: (work) => unitOfWork.execute(work),
      executeNextPending: (now, work) =>
        unitOfWork.executeNextPending(now, (context, transaction, lockedWallet) =>
          work(
            {
              ...context,
              insertOutboxMessages: () => Promise.reject(new Error('simulated outbox failure')),
            },
            transaction,
            lockedWallet,
          ),
        ),
    };
    const due = new Date(Date.now() + 10_000);
    expect(
      new ProcessWagerTransactionUseCase(failingUnitOfWork).reprocessNextPending(due),
    ).rejects.toThrow('simulated outbox failure');
    const em = orm.em.fork();
    const saved = await em.findOneOrFail(WagerTransactionEntity, { id: pending.transactionId });
    expect(saved.status).toBe(WagerTransactionStatus.PendingReference);
    expect(saved.referenceAttempts).toBe(0);
    expect(await em.count(WalletLedgerEntryEntity, { transactionId: pending.transactionId })).toBe(
      0,
    );
    expect(
      await em.count(OutboxMessageEntity, {
        aggregateId: pending.transactionId,
        eventType: 'WagerTransactionProcessed',
      }),
    ).toBe(0);
    await reconcile(wallet.id, '75.00');
    expect((await processor.reprocessNextPending(due))?.status).toBe(
      WagerTransactionStatus.Processed,
    );
    await reconcile(wallet.id, '100.00');
  });

  test('skips a locked wallet and processes a different wallet without waiting', async () => {
    const busy = await fixture();
    const free = await fixture();
    const busyPending = await processor.execute(busy.reversal);
    const freePending = await processor.execute(free.reversal);
    await processor.execute(busy.bet);
    await processor.execute(free.bet);
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = unitOfWork.execute(async (context) => {
      await context.lockWallet(busy.wallet.id);
      locked();
      await gate;
    });
    await ready;
    const due = new Date(Date.now() + 10_000);
    try {
      const result = await processor.reprocessNextPending(due);
      expect(result?.transactionId).toBe(freePending.transactionId);
    } finally {
      release();
      await holding;
    }
    expect((await processor.reprocessNextPending(due))?.transactionId).toBe(
      busyPending.transactionId,
    );
    await reconcile(busy.wallet.id, '100.00');
    await reconcile(free.wallet.id, '100.00');
  });

  test('exhausted references are rejected once with outbox and no financial effect', async () => {
    const { wallet, reversal } = await fixture();
    const pending = await processor.execute(reversal);
    const expiring = new ProcessWagerTransactionUseCase(
      unitOfWork,
      new ReferenceRetryPolicy({
        maxAttempts: 1,
        ttlMs: 86_400_000,
        baseDelayMs: 1_000,
        maxDelayMs: 300_000,
      }),
    );
    const result = await expiring.reprocessNextPending(new Date(Date.now() + 10_000));
    expect(result?.failureCode).toBe(FailureCode.ReferenceNotFound);
    const em = orm.em.fork();
    expect(await em.count(WalletLedgerEntryEntity, { transactionId: pending.transactionId })).toBe(
      0,
    );
    expect(
      await em.count(OutboxMessageEntity, {
        aggregateId: pending.transactionId,
        eventType: 'WagerTransactionRejected',
      }),
    ).toBe(1);
    await reconcile(wallet.id, '100.00');
  });

  test('scheduled worker processes a pending reference automatically and shuts down cleanly', async () => {
    const { wallet, bet, reversal } = await fixture();
    const fastPolicy = new ReferenceRetryPolicy({
      maxAttempts: 20,
      ttlMs: 86_400_000,
      baseDelayMs: 1,
      maxDelayMs: 10,
    });
    const fastProcessor = new ProcessWagerTransactionUseCase(unitOfWork, fastPolicy);
    const pending = await fastProcessor.execute(reversal);
    await fastProcessor.execute(bet);
    const worker = new PendingReferenceWorker(fastProcessor, {
      enabled: true,
      intervalMs: 10,
      batchSize: 25,
      ...fastPolicy.options,
    });
    worker.onApplicationBootstrap();
    try {
      const deadline = Date.now() + 5_000;
      let status: WagerTransactionStatus | undefined;
      while (Date.now() < deadline) {
        status = (await orm.em.fork().findOneOrFail(WagerTransactionEntity, pending.transactionId))
          .status;
        if (status === WagerTransactionStatus.Processed) break;
        await Bun.sleep(25);
      }
      expect(status).toBe(WagerTransactionStatus.Processed);
    } finally {
      await worker.beforeApplicationShutdown();
    }
    expect(
      await orm.em.fork().count(WalletLedgerEntryEntity, { transactionId: pending.transactionId }),
    ).toBe(1);
    await reconcile(wallet.id, '100.00');
  }, 10_000);
});
