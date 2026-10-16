import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ReconcileWalletUseCase } from '../../src/application/wallet/reconcile-wallet.use-case';
import { WalletReconciliationController } from '../../src/presentation/http/wallet-reconciliation.controller';
import { MikroOrmWalletReconciliationReader } from '../../src/infrastructure/database/queries/mikro-orm-wallet-reconciliation.reader';
import { CreateWalletUseCase } from '../../src/application/wallet/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import type { WageringUnitOfWork } from '../../src/application/wagering/ports/wagering-unit-of-work';
import { MikroOrmCreateWalletUnitOfWork } from '../../src/infrastructure/database/unit-of-work/mikro-orm-create-wallet.unit-of-work';
import { MikroOrmWageringUnitOfWork } from '../../src/infrastructure/database/unit-of-work/mikro-orm-wagering.unit-of-work';
import { WalletEntity } from '../../src/infrastructure/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/database/entities/wager-transaction.entity';
import { InboxMessageEntity } from '../../src/infrastructure/database/entities/inbox-message.entity';
import { OutboxMessageEntity } from '../../src/infrastructure/database/entities/outbox-message.entity';
import { Migration20261014000100 } from '../../src/infrastructure/database/migrations/Migration20261014000100';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import { ObservabilityModule } from '../../src/infrastructure/observability/observability.module';
import { ApplicationMetrics } from '../../src/infrastructure/observability/application.metrics';
import { configureHttp } from '../../src/presentation/http/configure-http';
import { HealthController } from '../../src/presentation/http/health.controller';
import { READINESS_PROBE } from '../../src/application/health/readiness-probe';

const databaseUrl = process.env.TEST_RECONCILIATION_DATABASE_URL;
describe.skipIf(databaseUrl === undefined)('Reconciliation and health over HTTP', () => {
  let orm: MikroORM;
  let app: INestApplication;
  let base: string;
  let create: CreateWalletUseCase;
  let processTransaction: ProcessWagerTransactionUseCase;
  let databaseUp = true;
  let sqsUp = true;
  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.endsWith('_test'))
      throw new Error('Test database must end in _test');
    orm = await MikroORM.init({
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
      pool: { min: 0, max: 10 },
    });
    await orm.getMigrator().up();
    create = new CreateWalletUseCase(new MikroOrmCreateWalletUnitOfWork(orm.em.fork()));
    processTransaction = new ProcessWagerTransactionUseCase(new MikroOrmWageringUnitOfWork(orm.em));
    const module = await Test.createTestingModule({
      imports: [ObservabilityModule],
      controllers: [WalletReconciliationController, HealthController],
      providers: [
        {
          provide: ReconcileWalletUseCase,
          inject: [ApplicationMetrics],
          useFactory: (metrics: ApplicationMetrics) =>
            new ReconcileWalletUseCase(new MikroOrmWalletReconciliationReader(orm.em), metrics),
        },
        {
          provide: READINESS_PROBE,
          useValue: {
            database: () =>
              databaseUp ? Promise.resolve() : Promise.reject(new Error('database down')),
            sqs: () => (sqsUp ? Promise.resolve() : Promise.reject(new Error('queue down'))),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  }, 30_000);
  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (orm !== undefined) await orm.close(true);
  }, 10_000);
  function wallet(amount = '100.00') {
    return create.execute({
      playerId: randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
      correlationId: randomUUID(),
    });
  }
  function command(
    id: string,
    playerId: string,
    kind: WagerTransactionKind.Bet | WagerTransactionKind.Win = WagerTransactionKind.Win,
    amount = '5.00',
  ) {
    return {
      providerId: 'reconciliation',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId: id,
      playerId,
      roundId: 'round',
      gameId: 'game',
      kind,
      money: { amount, currency: 'BRL' },
      correlationId: 'original-correlation',
    };
  }
  async function read(id: string) {
    const response = await fetch(`${base}/api/wallets/${id}/reconciliation`, {
      method: 'POST',
      headers: { 'x-correlation-id': 'reconciliation-trace' },
    });
    return {
      response,
      body: (await response.json()) as Awaited<ReturnType<ReconcileWalletUseCase['execute']>>,
    };
  }

  test('reconciles a referenced WIN with a different prize amount and an empty wallet', async () => {
    const w = await wallet();
    const bet = command(w.id, w.playerId, WagerTransactionKind.Bet, '25.00');
    await processTransaction.execute(bet);
    const win = await processTransaction.execute({
      ...command(w.id, w.playerId, WagerTransactionKind.Win, '60.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(win.status).toBe('PROCESSED' as typeof win.status);
    const result = await read(w.id);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('x-correlation-id')).toBe('reconciliation-trace');
    expect(result.body).toMatchObject({
      storedBalance: { amount: '135.00', currency: 'BRL' },
      calculatedBalance: { amount: '135.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
    const empty = await wallet('0.00');
    expect((await read(empty.id)).body).toMatchObject({
      consistent: true,
      checkedEntries: 0,
      calculatedBalance: { amount: '0.00' },
    });
  });
  test('detects divergence, emits a metric and never repairs the wallet', async () => {
    const w = await wallet();
    // Deliberate corruption is restricted to this isolated test database.
    await orm.em.fork().nativeUpdate(WalletEntity, { id: w.id }, { balance: '50.00' });
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect((await read(w.id)).body).toMatchObject({
        consistent: false,
        difference: { amount: '-50.00' },
        storedBalance: { amount: '50.00' },
        calculatedBalance: { amount: '100.00' },
      });
    expect((await orm.em.fork().findOneOrFail(WalletEntity, w.id)).balance).toBe('50.00');
    expect(await orm.em.fork().count(WalletLedgerEntryEntity, { walletId: w.id })).toBe(1);
    expect(await (await fetch(`${base}/metrics`)).text()).toContain(
      'wallet_reconciliation_divergences_total 2',
    );
  });
  test('uses one snapshot during an uncommitted wallet update and sees the next state after commit', async () => {
    const w = await wallet();
    const real = new MikroOrmWageringUnitOfWork(orm.em);
    let release!: () => void;
    let updated!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      updated = resolve;
    });
    const paused: WageringUnitOfWork = {
      execute: (work) =>
        real.execute((context) =>
          work({
            ...context,
            updateWallet: async (state) => {
              await context.updateWallet(state);
              updated();
              await gate;
            },
          }),
        ),
      executeNextPending: (now, work) => real.executeNextPending(now, work),
    };
    const writing = new ProcessWagerTransactionUseCase(paused).execute(command(w.id, w.playerId));
    await ready;
    try {
      expect((await read(w.id)).body).toMatchObject({
        consistent: true,
        storedBalance: { amount: '100.00' },
        checkedEntries: 1,
      });
    } finally {
      release();
      await writing;
    }
    expect((await read(w.id)).body).toMatchObject({
      consistent: true,
      storedBalance: { amount: '105.00' },
      calculatedBalance: { amount: '105.00' },
      checkedEntries: 2,
    });
  });
  test('returns not found and invalid IDs distinctly', async () => {
    expect((await read(randomUUID())).response.status).toBe(404);
    expect((await read('invalid')).response.status).toBe(400);
  });
  test('health remains public and liveness is independent of failing readiness checks', async () => {
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    sqsUp = false;
    try {
      const response = await fetch(`${base}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ checks: { database: 'up', sqs: 'down' } });
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
    } finally {
      sqsUp = true;
    }
    databaseUp = false;
    try {
      expect((await fetch(`${base}/health/ready`)).status).toBe(503);
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
    } finally {
      databaseUp = true;
    }
  });
});
