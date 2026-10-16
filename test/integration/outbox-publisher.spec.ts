import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { IntegrationEvent } from '../../src/domain/events/integration-event';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { PublishOutboxBatchUseCase } from '../../src/application/messaging/publish-outbox-batch.use-case';
import type { OutboxUnitOfWork } from '../../src/application/messaging/ports/outbox-unit-of-work';
import { OutboxMessageEntity } from '../../src/infrastructure/database/entities/outbox-message.entity';
import { InboxMessageEntity } from '../../src/infrastructure/database/entities/inbox-message.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/database/entities/wager-transaction.entity';
import { WalletEntity } from '../../src/infrastructure/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.entity';
import { Migration20261014000100 } from '../../src/infrastructure/database/migrations/Migration20261014000100';
import { OutboxMessageRepository } from '../../src/infrastructure/database/repositories/outbox-message.repository';
import { MikroOrmOutboxUnitOfWork } from '../../src/infrastructure/database/unit-of-work/mikro-orm-outbox.unit-of-work';
import { SqsIntegrationEventPublisher } from '../../src/infrastructure/messaging/sqs-integration-event.publisher';
import { OutboxPublisherWorker } from '../../src/infrastructure/workers/outbox-publisher.worker';
import { CreateWalletUseCase } from '../../src/application/wallet/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import { MikroOrmCreateWalletUnitOfWork } from '../../src/infrastructure/database/unit-of-work/mikro-orm-create-wallet.unit-of-work';
import { MikroOrmWageringUnitOfWork } from '../../src/infrastructure/database/unit-of-work/mikro-orm-wagering.unit-of-work';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';

const databaseUrl = process.env.TEST_OUTBOX_DATABASE_URL;
const endpoint = process.env.TEST_SQS_ENDPOINT;

class TestEvent extends IntegrationEvent<{ readonly value: string }> {
  readonly eventType = 'OutboxTestEvent';
  readonly version = 1;
  constructor() {
    super({
      eventId: randomUUID(),
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      occurredAt: new Date(Date.now() - 60_000),
      data: { value: 'test' },
    });
  }
}

describe.skipIf(databaseUrl === undefined || endpoint === undefined)(
  'Outbox publisher with PostgreSQL and LocalStack',
  () => {
    let orm: MikroORM;
    let client: SQSClient;
    let queueUrl: string;
    let store: MikroOrmOutboxUnitOfWork;
    let publisher: SqsIntegrationEventPublisher;
    let useCase: PublishOutboxBatchUseCase;

    function sqsClient(): SQSClient {
      return new SQSClient({
        endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
    }

    beforeAll(async () => {
      if (!new URL(databaseUrl!).pathname.endsWith('_test'))
        throw new Error('TEST_OUTBOX_DATABASE_URL must end in _test');
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
      client = sqsClient();
      queueUrl = (
        await client.send(
          new CreateQueueCommand({
            QueueName: `integration-outbox-${randomUUID()}.fifo`,
            Attributes: { FifoQueue: 'true' },
          }),
        )
      ).QueueUrl!;
      store = new MikroOrmOutboxUnitOfWork(orm.em);
      publisher = new SqsIntegrationEventPublisher(client, queueUrl);
      useCase = new PublishOutboxBatchUseCase(store, publisher);
    });

    afterAll(async () => {
      if (queueUrl !== undefined) await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      client?.destroy();
      if (orm !== undefined) await orm.close(true);
    });

    async function seed(count = 1): Promise<OutboxMessage[]> {
      const messages = Array.from({ length: count }, () => OutboxMessage.enqueue(new TestEvent()));
      await orm.em
        .fork()
        .transactional((em) => new OutboxMessageRepository().insertMany(em, messages));
      return messages;
    }

    async function receive(count: number): Promise<unknown[]> {
      const bodies: unknown[] = [];
      for (let pass = 0; bodies.length < count && pass < 10; pass += 1) {
        const result = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );
        for (const message of result.Messages ?? []) {
          const payload: unknown = JSON.parse(message.Body!);
          bodies.push(payload);
          await client.send(
            new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }),
          );
        }
      }
      expect(bodies).toHaveLength(count);
      return bodies;
    }

    test('publishes the committed envelope unchanged and measures pending age', async () => {
      const [message] = await seed();
      const before = await store.pendingMetrics(new Date());
      expect(before.pending).toBe(1);
      expect(before.oldestPendingAgeMs).toBeGreaterThanOrEqual(60_000);
      const result = await useCase.execute(25);
      expect(result.published).toBe(1);
      expect(result.pending).toBe(0);
      expect(result.oldestPendingAgeMs).toBe(0);
      expect(
        (await orm.em.fork().findOneOrFail(OutboxMessageEntity, message!.id)).publishedAt,
      ).not.toBeNull();
      expect(await receive(1)).toEqual([message!.payload]);
      expect((await useCase.execute(25)).selected).toBe(0);
    });

    test('never publishes an event from a transaction that has not committed', async () => {
      let inserted!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        inserted = resolve;
      });

      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const message = OutboxMessage.enqueue(new TestEvent());
      const writing = orm.em.fork().transactional(async (em) => {
        await new OutboxMessageRepository().insertMany(em, [message]);
        inserted();
        await gate;
        throw new Error('simulated financial rollback');
      });
      await ready;
      let rolledBack = false;
      try {
        expect((await useCase.execute(25)).selected).toBe(0);
      } finally {
        release();
        await writing.catch(() => {
          rolledBack = true;
        });
      }
      expect(rolledBack).toBe(true);
      expect(await orm.em.fork().count(OutboxMessageEntity, { id: message.id })).toBe(0);
      expect((await useCase.execute(25)).selected).toBe(0);
    });

    test('publishes actual wallet opening and BET events without changing the financial balance', async () => {
      const playerId = randomUUID();
      const wallet = await new CreateWalletUseCase(
        new MikroOrmCreateWalletUnitOfWork(orm.em.fork()),
      ).execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });
      await new ProcessWagerTransactionUseCase(new MikroOrmWageringUnitOfWork(orm.em)).execute({
        providerId: `outbox-${randomUUID()}`,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        playerId,
        walletId: wallet.id,
        roundId: 'round',
        gameId: 'game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });
      const expected = await orm.em.fork().find(OutboxMessageEntity, { publishedAt: null });
      expect(expected).toHaveLength(4);
      expect(expected.map((message) => message.eventType).sort()).toEqual([
        'WagerTransactionProcessed',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
        'WalletBalanceChanged',
      ]);
      expect((await useCase.execute(25)).published).toBe(4);
      const bodies = await receive(4);
      for (const message of expected) expect(bodies).toContainEqual(message.payload);
      const rows = await orm.em.fork().execute<{ balance: string; reconstructed: string }[]>(
        `
        select w.balance, sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end)::numeric(20,2) as reconstructed
        from wallets w join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ? group by w.id
      `,
        [wallet.id],
      );
      expect(rows[0]?.balance).toBe('75.00');
      expect(rows[0]?.reconstructed).toBe('75.00');
    });

    test('persists send failures, waits for the due date and publishes on retry', async () => {
      const [message] = await seed();
      const failed = new PublishOutboxBatchUseCase(store, {
        publish: () => Promise.reject(new Error('SQS unavailable')),
        close: () => {},
      });
      expect((await failed.execute(1)).failed).toBe(1);
      const saved = await orm.em.fork().findOneOrFail(OutboxMessageEntity, message!.id);
      expect(saved.attempts).toBe(1);
      expect(saved.publishedAt).toBeNull();
      expect(saved.nextAttemptAt).not.toBeNull();
      expect((await useCase.execute(1)).selected).toBe(0);
      await Bun.sleep(1_050);
      expect((await useCase.execute(1)).published).toBe(1);
      const published = await orm.em.fork().findOneOrFail(OutboxMessageEntity, message!.id);
      expect(published.attempts).toBe(1);
      expect(published.nextAttemptAt).toBeNull();
      expect(await receive(1)).toEqual([message!.payload]);
    });

    test('two publishers reserve disjoint batches with SKIP LOCKED', async () => {
      const messages = await seed(4);
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entering = new Promise<void>((resolve) => {
        started = resolve;
      });
      const first = new PublishOutboxBatchUseCase(store, {
        publish: async (message) => {
          started();
          await gate;
          await publisher.publish(message);
        },
        close: () => {},
      }).execute(2);
      await entering;
      try {
        const second = await Promise.race([
          useCase.execute(2),
          Bun.sleep(2_000).then(() => {
            throw new Error('Second publisher waited for locked rows');
          }),
        ]);
        expect(second.published).toBe(2);
      } finally {
        release();
        await first;
      }
      expect(
        await orm.em.fork().count(OutboxMessageEntity, {
          id: { $in: messages.map((message) => message.id) },
          publishedAt: { $ne: null },
        }),
      ).toBe(4);
      const bodies = await receive(4);
      for (const message of messages) expect(bodies).toContainEqual(message.payload);
      expect((await useCase.execute(25)).selected).toBe(0);
    });

    test('failure after send before database confirmation retries the same eventId safely', async () => {
      const [message] = await seed();
      const sentIds: string[] = [];
      const trackingPublisher = {
        publish: async (event: OutboxMessage) => {
          sentIds.push(event.id);
          await publisher.publish(event);
        },
        close: () => {},
      };
      const failingStore: OutboxUnitOfWork = {
        executeBatch: (now, limit, work) =>
          store.executeBatch(now, limit, (context) =>
            work({
              ...context,
              save: () => Promise.reject(new Error('simulated failure after send')),
            }),
          ),
        pendingMetrics: (now) => store.pendingMetrics(now),
      };
      let failed = false;
      await new PublishOutboxBatchUseCase(failingStore, trackingPublisher).execute(1).catch(() => {
        failed = true;
      });
      expect(failed).toBe(true);
      expect(
        (await orm.em.fork().findOneOrFail(OutboxMessageEntity, message!.id)).publishedAt,
      ).toBeNull();
      // A new publisher instance recovers the unconfirmed event after the rollback.
      const recovered = new PublishOutboxBatchUseCase(
        new MikroOrmOutboxUnitOfWork(orm.em),
        trackingPublisher,
      );
      expect((await recovered.execute(1)).published).toBe(1);
      expect(sentIds).toEqual([message!.id, message!.id]);
      expect(await receive(1)).toEqual([message!.payload]);
      // FIFO deduplication suppresses the immediate duplicate; consumers still need
      // persistent eventId deduplication for retries outside the five-minute window.
      expect(
        (await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 })))
          .Messages ?? [],
      ).toHaveLength(0);
    });

    test('background publisher starts automatically and shuts down after committing', async () => {
      const [message] = await seed();
      const ownPublisher = new SqsIntegrationEventPublisher(sqsClient(), queueUrl);
      const worker = new OutboxPublisherWorker(
        new PublishOutboxBatchUseCase(store, ownPublisher),
        ownPublisher,
        { enabled: true, intervalMs: 10, batchSize: 25 },
      );
      worker.onApplicationBootstrap();
      try {
        const deadline = Date.now() + 5_000;
        while (worker.metrics.published === 0 && Date.now() < deadline) await Bun.sleep(25);
        expect(worker.metrics.published).toBe(1);
        expect(worker.metrics.pending).toBe(0);
      } finally {
        await worker.beforeApplicationShutdown();
      }
      expect(
        (await orm.em.fork().findOneOrFail(OutboxMessageEntity, message!.id)).publishedAt,
      ).not.toBeNull();
      expect(await receive(1)).toEqual([message!.payload]);
    });
  },
);
