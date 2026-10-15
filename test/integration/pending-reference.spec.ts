import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, spyOn } from 'bun:test';
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
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteQueueCommand,
} from '@aws-sdk/client-sqs';
import { SqsWagerQueue } from '../../src/infrastructure/messaging/sqs-wager.queue';
import { SqsWagerConsumer } from '../../src/infrastructure/workers/sqs-wager.consumer';
import { WAGER_CONSUMER_NAME } from '../../src/infrastructure/messaging/wager-queue';
import { sha256CanonicalJson } from '../../src/application/shared/canonical-json';
import { InboxPayloadConflictError } from '../../src/application/wagering/ports/inbox-delivery';

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

  describe.skipIf(process.env.TEST_SQS_ENDPOINT === undefined)(
    'SQS and inbox with LocalStack',
    () => {
      let client: SQSClient;
      let queueUrl: string;
      let dlqUrl: string;
      let queue: SqsWagerQueue;
      const options = {
        enabled: true,
        visibilitySeconds: 3,
        heartbeatMs: 1_000,
        retryBaseSeconds: 1,
        retryMaxSeconds: 1,
      };

      beforeAll(async () => {
        client = new SQSClient({
          endpoint: process.env.TEST_SQS_ENDPOINT,
          region: 'us-east-1',
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        });
        dlqUrl = (
          await client.send(
            new CreateQueueCommand({
              QueueName: `integration-dlq-${randomUUID()}.fifo`,
              Attributes: { FifoQueue: 'true' },
            }),
          )
        ).QueueUrl!;
        const arn = (
          await client.send(
            new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
          )
        ).Attributes!.QueueArn!;
        queueUrl = (
          await client.send(
            new CreateQueueCommand({
              QueueName: `integration-wager-${randomUUID()}.fifo`,
              Attributes: {
                FifoQueue: 'true',
                VisibilityTimeout: '3',
                RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '3' }),
              },
            }),
          )
        ).QueueUrl!;
        queue = new SqsWagerQueue(client, queueUrl, dlqUrl, options.visibilitySeconds);
      });

      afterAll(async () => {
        if (queueUrl !== undefined)
          await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        if (dlqUrl !== undefined) await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
        client?.destroy();
      });

      function envelope(command: ProcessWagerTransactionCommand) {
        const { correlationId, ...data } = command;
        return {
          messageId: randomUUID(),
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          correlationId,
          data,
        };
      }

      async function send(body: string, groupId: string) {
        await client.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: body,
            MessageGroupId: groupId,
            MessageDeduplicationId: randomUUID(),
          }),
        );
        const delivery = await queue.receive(new AbortController().signal);
        if (delivery === undefined) throw new Error('Test message was not delivered');
        return delivery;
      }

      test('redelivery after commit before ack preserves one inbox, ledger and processed event', async () => {
        const { wallet, bet } = await fixture();
        const request = envelope(bet);
        const delivery = await send(JSON.stringify(request), wallet.id);
        const consumer = new SqsWagerConsumer(queue, processor, options);
        const ack = spyOn(queue, 'acknowledge').mockRejectedValueOnce(
          new Error('simulated crash before ack'),
        );
        try {
          await consumer.handle(delivery);
        } finally {
          ack.mockRestore();
        }
        const em = orm.em.fork();
        expect(
          await em.count(InboxMessageEntity, {
            consumerName: WAGER_CONSUMER_NAME,
            messageId: request.messageId,
          }),
        ).toBe(1);
        await reconcile(wallet.id, '75.00');
        const redelivery = await queue.receive(new AbortController().signal);
        expect(redelivery?.messageId).toBe(delivery.messageId);
        expect(redelivery?.receiveCount).toBe(2);
        await consumer.handle(redelivery!);
        const transaction = await em.findOneOrFail(WagerTransactionEntity, {
          idempotencyKey: bet.idempotencyKey,
        });
        expect(await em.count(WalletLedgerEntryEntity, { transactionId: transaction.id })).toBe(1);
        expect(
          await em.count(OutboxMessageEntity, {
            aggregateId: transaction.id,
            eventType: 'WagerTransactionProcessed',
          }),
        ).toBe(1);
        expect(
          (
            await em.findOneOrFail(InboxMessageEntity, {
              consumerName: WAGER_CONSUMER_NAME,
              messageId: request.messageId,
            })
          ).processedAt,
        ).not.toBeNull();
        await reconcile(wallet.id, '75.00');
      }, 30_000);

      test('failure before commit rolls back inbox with wallet, transaction, ledger and outbox', async () => {
        const { wallet, bet } = await fixture();
        const request = envelope(bet);
        const delivery = await send(JSON.stringify(request), wallet.id);
        const failing: WageringUnitOfWork = {
          execute: (work) =>
            unitOfWork.execute((context) =>
              work({
                ...context,
                insertOutboxMessages: () =>
                  Promise.reject(new Error('simulated precommit failure')),
              }),
            ),
          executeNextPending: (now, work) => unitOfWork.executeNextPending(now, work),
        };
        await new SqsWagerConsumer(
          queue,
          new ProcessWagerTransactionUseCase(failing),
          options,
        ).handle(delivery);
        const em = orm.em.fork();
        expect(await em.count(InboxMessageEntity, { messageId: request.messageId })).toBe(0);
        expect(await em.count(WagerTransactionEntity, { idempotencyKey: bet.idempotencyKey })).toBe(
          0,
        );
        await reconcile(wallet.id, '100.00');
        const redelivery = await queue.receive(new AbortController().signal);
        await new SqsWagerConsumer(queue, processor, options).handle(redelivery!);
        expect(await em.count(InboxMessageEntity, { messageId: request.messageId })).toBe(1);
        await reconcile(wallet.id, '75.00');
      }, 30_000);

      test('invalid JSON is delivered to the real DLQ without a financial effect', async () => {
        const delivery = await send('{invalid', randomUUID());
        await new SqsWagerConsumer(queue, processor, options).handle(delivery);
        const result = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: dlqUrl,
            WaitTimeSeconds: 1,
            MessageAttributeNames: ['All'],
          }),
        );
        expect(result.Messages?.[0]?.Body).toBe('{invalid');
        expect(result.Messages?.[0]?.MessageAttributes?.failureCode?.StringValue).toBe(
          'INVALID_WAGER_MESSAGE',
        );
      }, 30_000);

      test('concurrent deliveries of one envelope serialize through the inbox', async () => {
        const { wallet, bet } = await fixture();
        const request = envelope(bet);
        const delivery = {
          consumerName: WAGER_CONSUMER_NAME,
          messageId: request.messageId,
          payloadHash: sha256CanonicalJson(request.data),
        };
        const results = await Promise.all([
          processor.execute(bet, delivery),
          processor.execute(bet, delivery),
        ]);
        expect(results.filter((result) => result.idempotentReplay)).toHaveLength(1);
        expect(
          await orm.em.fork().count(InboxMessageEntity, { messageId: request.messageId }),
        ).toBe(1);
        await reconcile(wallet.id, '75.00');
      });

      test('reusing an inbox identifier with another payload is rejected without a second debit', async () => {
        const { wallet, bet } = await fixture();
        const delivery = {
          consumerName: WAGER_CONSUMER_NAME,
          messageId: randomUUID(),
          payloadHash: sha256CanonicalJson(bet),
        };
        await processor.execute(bet, delivery);
        expect(
          processor.execute(
            { ...bet, money: { amount: '30.00', currency: 'BRL' } },
            { ...delivery, payloadHash: 'a'.repeat(64) },
          ),
        ).rejects.toBeInstanceOf(InboxPayloadConflictError);
        await reconcile(wallet.id, '75.00');
      });

      test('background consumer polls SQS automatically and drains on shutdown', async () => {
        const { wallet, bet } = await fixture();
        const request = envelope(bet);
        // Keep a cancelled long poll from receiving a later test's message on the server.
        const ownQueueUrl = (
          await client.send(
            new CreateQueueCommand({
              QueueName: `integration-background-${randomUUID()}.fifo`,
              Attributes: { FifoQueue: 'true' },
            }),
          )
        ).QueueUrl!;
        const ownClient = new SQSClient({
          endpoint: process.env.TEST_SQS_ENDPOINT,
          region: 'us-east-1',
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        });
        const consumer = new SqsWagerConsumer(
          new SqsWagerQueue(ownClient, ownQueueUrl, dlqUrl, options.visibilitySeconds),
          processor,
          options,
        );
        consumer.onApplicationBootstrap();
        try {
          await client.send(
            new SendMessageCommand({
              QueueUrl: ownQueueUrl,
              MessageBody: JSON.stringify(request),
              MessageGroupId: wallet.id,
              MessageDeduplicationId: randomUUID(),
            }),
          );
          const deadline = Date.now() + 10_000;
          let processed = false;
          while (Date.now() < deadline) {
            processed =
              (
                await orm.em.fork().findOne(InboxMessageEntity, {
                  messageId: request.messageId,
                  consumerName: WAGER_CONSUMER_NAME,
                })
              )?.processedAt != null;
            if (processed) break;
            await Bun.sleep(25);
          }
          expect(processed).toBe(true);
        } finally {
          await consumer.beforeApplicationShutdown();
          await client.send(new DeleteQueueCommand({ QueueUrl: ownQueueUrl }));
        }
        await reconcile(wallet.id, '75.00');
      }, 30_000);

      test('transient failures reach DLQ after the configured receive limit', async () => {
        const { wallet, bet } = await fixture();
        let delivery = await send(JSON.stringify(envelope(bet)), wallet.id);
        const consumer = new SqsWagerConsumer(
          queue,
          { execute: () => Promise.reject(new Error('temporary outage')) },
          options,
        );
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await consumer.handle(delivery);
          await queue.changeVisibility(delivery.receiptHandle, 0);
          if (attempt < 3) delivery = (await queue.receive(new AbortController().signal))!;
        }
        // The next receive triggers the queue's redrive policy.
        await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }));
        const dlq = await client.send(
          new ReceiveMessageCommand({ QueueUrl: dlqUrl, WaitTimeSeconds: 2 }),
        );
        expect(dlq.Messages?.[0]?.Body).toBe(delivery.body);
        await reconcile(wallet.id, '100.00');
      }, 30_000);
    },
  );

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
