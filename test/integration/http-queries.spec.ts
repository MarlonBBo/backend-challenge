import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletController } from '../../src/presentation/http/wallet.controller';
import { WageringController } from '../../src/presentation/http/wagering.controller';
import { ProviderWageringController } from '../../src/presentation/http/provider-wagering.controller';
import { CreateWalletUseCase } from '../../src/application/wallet/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/application/wallet/get-wallet.use-case';
import { GetWagerTransactionUseCase } from '../../src/application/wagering/get-wager-transaction.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import { MikroOrmWalletReader } from '../../src/infrastructure/database/queries/mikro-orm-wallet.reader';
import { MikroOrmWagerTransactionReader } from '../../src/infrastructure/database/queries/mikro-orm-wager-transaction.reader';
import { MikroOrmCreateWalletUnitOfWork } from '../../src/infrastructure/database/unit-of-work/mikro-orm-create-wallet.unit-of-work';
import { MikroOrmWageringUnitOfWork } from '../../src/infrastructure/database/unit-of-work/mikro-orm-wagering.unit-of-work';
import { WalletEntity } from '../../src/infrastructure/database/entities/wallet.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/database/entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.entity';
import { InboxMessageEntity } from '../../src/infrastructure/database/entities/inbox-message.entity';
import { OutboxMessageEntity } from '../../src/infrastructure/database/entities/outbox-message.entity';
import { Migration20261014000100 } from '../../src/infrastructure/database/migrations/Migration20261014000100';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)('HTTP queries with PostgreSQL', () => {
  let orm: MikroORM;
  let app: INestApplication;
  let baseUrl: string;
  let walletId: string;
  let playerId: string;
  let transactionId: string;
  const provider = `query:${randomUUID()}`;
  const externalId = 'bet:/same id';

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
    const createWallet = new CreateWalletUseCase(new MikroOrmCreateWalletUnitOfWork(orm.em.fork()));
    const processTransaction = new ProcessWagerTransactionUseCase(
      new MikroOrmWageringUnitOfWork(orm.em),
    );
    const module = await Test.createTestingModule({
      controllers: [WalletController, WageringController, ProviderWageringController],
      providers: [
        { provide: CreateWalletUseCase, useValue: createWallet },
        { provide: ProcessWagerTransactionUseCase, useValue: processTransaction },
        {
          provide: GetWalletUseCase,
          useValue: new GetWalletUseCase(new MikroOrmWalletReader(orm.em)),
        },
        {
          provide: GetWagerTransactionUseCase,
          useValue: new GetWagerTransactionUseCase(new MikroOrmWagerTransactionReader(orm.em)),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/api`;
    playerId = randomUUID();
    const created = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    expect(created.status).toBe(201);
    const wallet: unknown = await created.json();
    if (
      wallet === null ||
      typeof wallet !== 'object' ||
      !('id' in wallet) ||
      typeof wallet.id !== 'string'
    )
      throw new Error('Missing created wallet');
    walletId = wallet.id;
    const bet = await submit('BET', provider, externalId, '25.00');
    expect(bet.status).toBe(201);
    const transaction: unknown = await bet.json();
    if (
      transaction === null ||
      typeof transaction !== 'object' ||
      !('transactionId' in transaction) ||
      typeof transaction.transactionId !== 'string'
    )
      throw new Error('Missing created transaction');
    transactionId = transaction.transactionId;
    // Same external identifier is valid for another provider. It must not shadow the first.
    expect((await submit('WIN', `${provider}-other`, externalId, '10.00')).status).toBe(201);
  }, 30_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (orm !== undefined) await orm.close(true);
  }, 10_000);

  function submit(kind: string, providerId: string, externalTransactionId: string, amount: string) {
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        providerId,
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'query-round',
        gameId: 'query-game',
        kind,
        money: { amount, currency: 'BRL' },
      }),
    });
  }

  test('wallet query returns the latest balance after movements and does not write records', async () => {
    const em = orm.em.fork();
    const before = {
      transactions: await em.count(WagerTransactionEntity, { walletId }),
      ledger: await em.count(WalletLedgerEntryEntity, { walletId }),
      outbox: await em.count(OutboxMessageEntity, {}),
    };
    const response = await fetch(`${baseUrl}/wallets/${walletId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: walletId,
      playerId,
      balance: { amount: '85.00', currency: 'BRL' },
      version: 3,
    });
    expect(await em.count(WagerTransactionEntity, { walletId })).toBe(before.transactions);
    expect(await em.count(WalletLedgerEntryEntity, { walletId })).toBe(before.ledger);
    expect(await em.count(OutboxMessageEntity, {})).toBe(before.outbox);
  });

  test('both transaction endpoints return the same persisted result, including the original balance', async () => {
    const internal = await fetch(`${baseUrl}/wagering/transactions/${transactionId}`);
    const external = await fetch(
      `${baseUrl}/providers/${encodeURIComponent(provider)}/wagering/transactions/${encodeURIComponent(externalId)}`,
    );
    expect(internal.status).toBe(200);
    expect(external.status).toBe(200);
    const body: unknown = await internal.json();
    expect(body).toEqual(await external.json());
    expect(body).toMatchObject({
      id: transactionId,
      providerId: provider,
      externalTransactionId: externalId,
      status: 'PROCESSED',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
      failureCode: null,
    });
    expect(body).not.toHaveProperty('payloadHash');
    expect(body).not.toHaveProperty('idempotencyKey');
  });

  test('rejected transactions remain queryable with their failure code and observed balance', async () => {
    const rejection = await submit('BET', provider, randomUUID(), '1000.00');
    expect(rejection.status).toBe(422);
    const result: unknown = await rejection.json();
    if (
      result === null ||
      typeof result !== 'object' ||
      !('transactionId' in result) ||
      typeof result.transactionId !== 'string'
    )
      throw new Error('Missing rejected transaction');
    const response = await fetch(`${baseUrl}/wagering/transactions/${result.transactionId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '85.00', currency: 'BRL' },
    });
  });

  test('missing wallet and transactions return 404 with stable error codes', async () => {
    for (const [path, code] of [
      [`wallets/${randomUUID()}`, 'WALLET_NOT_FOUND'],
      [`wagering/transactions/${randomUUID()}`, 'TRANSACTION_NOT_FOUND'],
      [
        `providers/unknown/wagering/transactions/${encodeURIComponent(externalId)}`,
        'TRANSACTION_NOT_FOUND',
      ],
    ]) {
      const response = await fetch(`${baseUrl}/${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code });
    }
  });

  test('malformed IDs return 400 and external identifiers retain their provider scope', async () => {
    for (const path of [
      'wallets/not-a-uuid',
      'wagering/transactions/not-a-uuid',
      `providers/${'p'.repeat(101)}/wagering/transactions/id`,
      'providers/provider/wagering/transactions/%20id%20',
    ]) {
      const response = await fetch(`${baseUrl}/${path}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'INVALID_PATH_PARAMETER' });
    }
    const response = await fetch(
      `${baseUrl}/providers/${encodeURIComponent(`${provider}-other`)}/wagering/transactions/${encodeURIComponent(externalId)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      providerId: `${provider}-other`,
      kind: 'WIN',
      money: { amount: '10.00', currency: 'BRL' },
    });
  });
});
