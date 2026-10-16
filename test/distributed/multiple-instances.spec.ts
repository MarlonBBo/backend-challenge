import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
} from '@aws-sdk/client-sqs';
import { WalletEntity } from '../../src/infrastructure/database/entities/wallet.entity';
import { WagerTransactionEntity } from '../../src/infrastructure/database/entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.entity';
import { InboxMessageEntity } from '../../src/infrastructure/database/entities/inbox-message.entity';
import { OutboxMessageEntity } from '../../src/infrastructure/database/entities/outbox-message.entity';
import { Migration20261014000100 } from '../../src/infrastructure/database/migrations/Migration20261014000100';
import { WalletRepository } from '../../src/infrastructure/database/repositories/wallet.repository';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';

const databaseUrl = process.env.TEST_DISTRIBUTED_DATABASE_URL;
const endpoint = process.env.TEST_SQS_ENDPOINT;
type NodeInstance = {
  base: string;
  process: ReturnType<typeof Bun.spawn>;
  output: Promise<string>;
  errors: Promise<string>;
};
type TestWallet = { id: string; playerId: string };

describe.skipIf(databaseUrl === undefined || endpoint === undefined)(
  'Three actual application processes',
  () => {
    let orm: MikroORM;
    let client: SQSClient;
    let queueUrl: string;
    let dlqUrl: string;
    let eventsUrl: string;
    let directory: string;
    let nodes: NodeInstance[] = [];
    const allNodes: NodeInstance[] = [];
    const wallets = new Map<string, string>();

    async function waitFor(check: () => Promise<boolean>, milliseconds = 15_000) {
      const end = Date.now() + milliseconds;
      while (Date.now() < end) {
        if (await check()) return;
        await Bun.sleep(50);
      }
      throw new Error('Timed out waiting for distributed condition');
    }

    async function start(extra: Record<string, string> = {}): Promise<NodeInstance> {
      const reservation = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: () => new Response('reserved'),
      });
      const port = reservation.port!;
      await Promise.resolve(reservation.stop(true));
      const processHandle = Bun.spawn([process.execPath, 'test/fixtures/distributed-server.ts'], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          NODE_ENV: 'production',
          LOG_LEVEL: 'error',
          PORT: String(port),
          DATABASE_URL: databaseUrl!,
          DATABASE_POOL_MIN: '0',
          DATABASE_POOL_MAX: '3',
          AWS_REGION: 'us-east-1',
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          SQS_ENDPOINT: endpoint!,
          SQS_WAGER_QUEUE_URL: queueUrl,
          SQS_WAGER_DLQ_URL: dlqUrl,
          SQS_EVENTS_QUEUE_URL: eventsUrl,
          SQS_CONSUMER_ENABLED: 'false',
          SQS_VISIBILITY_SECONDS: '3',
          SQS_HEARTBEAT_MS: '1000',
          REFERENCE_WORKER_ENABLED: 'true',
          REFERENCE_WORKER_INTERVAL_MS: '100',
          OUTBOX_WORKER_ENABLED: 'true',
          OUTBOX_WORKER_INTERVAL_MS: '60000',
          ...extra,
        },
      });
      const node: NodeInstance = {
        base: `http://127.0.0.1:${port}`,
        process: processHandle,
        output: new Response(processHandle.stdout).text(),
        errors: new Response(processHandle.stderr).text(),
      };
      allNodes.push(node);
      await waitFor(async () => {
        if (processHandle.exitCode !== null)
          throw new Error(`Child exited: ${await node.errors}\n${await node.output}`);
        try {
          const response = await fetch(`${node.base}/health/live`, {
            signal: AbortSignal.timeout(500),
          });
          await response.text();
          return response.status === 200;
        } catch {
          return false;
        }
      });
      const ready = await fetch(`${node.base}/health/ready`);
      expect(ready.status).toBe(200);
      await ready.text();
      return node;
    }

    async function stop(node: NodeInstance, force = false) {
      if (node.process.exitCode !== null) return;
      node.process.kill(force ? 'SIGKILL' : 'SIGTERM');
      await Promise.race([
        node.process.exited,
        Bun.sleep(3_000).then(() => {
          if (node.process.exitCode === null) node.process.kill('SIGKILL');
        }),
      ]);
      await node.process.exited;
    }

    beforeAll(async () => {
      if (!new URL(databaseUrl!).pathname.endsWith('_test'))
        throw new Error('Distributed database must end in _test');
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
        pool: { min: 0, max: 5 },
      });
      await orm.getMigrator().up();
      directory = await mkdtemp(join(tmpdir(), 'wager-distributed-'));
      client = new SQSClient({
        endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
      dlqUrl = (
        await client.send(
          new CreateQueueCommand({
            QueueName: `distributed-dlq-${randomUUID()}.fifo`,
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
            QueueName: `distributed-wager-${randomUUID()}.fifo`,
            Attributes: {
              FifoQueue: 'true',
              VisibilityTimeout: '3',
              RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '5' }),
            },
          }),
        )
      ).QueueUrl!;
      eventsUrl = (
        await client.send(
          new CreateQueueCommand({
            QueueName: `distributed-events-${randomUUID()}.fifo`,
            Attributes: { FifoQueue: 'true' },
          }),
        )
      ).QueueUrl!;
      nodes = await Promise.all([start(), start(), start()]);
      expect(new Set(nodes.map((node) => node.process.pid)).size).toBe(3);
    }, 60_000);

    afterAll(async () => {
      await Promise.all(allNodes.map((node) => stop(node)));
      for (const QueueUrl of [queueUrl, dlqUrl, eventsUrl])
        if (QueueUrl !== undefined) await client.send(new DeleteQueueCommand({ QueueUrl }));
      client?.destroy();
      if (orm !== undefined) await orm.close(true);
      // Only the directory created by mkdtemp above is eligible for cleanup.
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }, 30_000);

    async function request(node: NodeInstance, path: string, body?: unknown, key = randomUUID()) {
      const response = await fetch(`${node.base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'x-correlation-id': 'distributed-trace',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value: unknown = await response.json();
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid JSON response');
      return { status: response.status, body: value as Record<string, unknown> };
    }
    async function wallet(): Promise<TestWallet> {
      const playerId = randomUUID();
      const result = await request(nodes[0]!, '/api/wallets', {
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      expect(result.status).toBe(201);
      if (typeof result.body.id !== 'string') throw new Error('Missing wallet');
      wallets.set(result.body.id, '100.00');
      return { id: result.body.id, playerId };
    }
    function command(w: TestWallet, amount = '25.00') {
      return {
        providerId: `provider-${w.id}`,
        externalTransactionId: randomUUID(),
        playerId: w.playerId,
        walletId: w.id,
        roundId: 'round',
        gameId: 'game',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      };
    }
    async function assertBalance(w: TestWallet, amount: string) {
      const result = await request(nodes[0]!, `/api/wallets/${w.id}/reconciliation`, {});
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        consistent: true,
        storedBalance: { amount },
        calculatedBalance: { amount },
        difference: { amount: '0.00' },
      });
      wallets.set(w.id, amount);
    }

    test('50 parallel requests across three PIDs produce one debit', async () => {
      const w = await wallet();
      const body = command(w);
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          request(nodes[index % 3]!, '/api/wagering/transactions', body, key),
        ),
      );
      expect(results.filter((result) => result.status === 201)).toHaveLength(1);
      const unexpected = results.filter((result) => result.status !== 201 && result.status !== 200);
      if (unexpected.length > 0) throw new Error(JSON.stringify(unexpected));
      expect(
        results.filter((result) => result.status === 200 && result.body.idempotentReplay === true),
      ).toHaveLength(49);
      expect(
        await orm.em
          .fork()
          .count(WalletLedgerEntryEntity, { walletId: w.id, direction: LedgerDirection.Debit }),
      ).toBe(1);
      await assertBalance(w, '75.00');
    }, 30_000);

    test('two 80.00 bets race for 100.00 across processes', async () => {
      const w = await wallet();
      const results = await Promise.all([
        request(nodes[0]!, '/api/wagering/transactions', command(w, '80.00')),
        request(nodes[1]!, '/api/wagering/transactions', command(w, '80.00')),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
      expect(
        await orm.em
          .fork()
          .count(WalletLedgerEntryEntity, { walletId: w.id, direction: LedgerDirection.Debit }),
      ).toBe(1);
      await assertBalance(w, '20.00');
    });

    test('a locked wallet does not block another wallet on another process', async () => {
      const a = await wallet();
      const b = await wallet();
      let release!: () => void;
      let locked!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = orm.em.fork().transactional(async (em) => {
        await new WalletRepository().findByIdForUpdate(em, a.id);
        locked();
        await gate;
      });
      await ready;
      let completed = false;
      const blocked = request(nodes[0]!, '/api/wagering/transactions', command(a, '1.00')).then(
        (result) => {
          completed = true;
          return result;
        },
      );
      try {
        const independent = await Promise.race([
          request(nodes[1]!, '/api/wagering/transactions', command(b, '1.00')),
          Bun.sleep(2_000).then(() => {
            throw new Error('Different wallet was blocked');
          }),
        ]);
        expect(independent.status).toBe(201);
        expect(completed).toBe(false);
      } finally {
        release();
        await holding;
      }
      expect((await blocked).status).toBe(201);
      await assertBalance(a, '99.00');
      await assertBalance(b, '99.00');
    });

    test('out-of-order REFUND is recovered once and keeps its original correlation', async () => {
      const w = await wallet();
      const bet = command(w);
      const refund = await request(nodes[0]!, '/api/wagering/transactions', {
        ...bet,
        externalTransactionId: randomUUID(),
        kind: 'REFUND',
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect(refund.status).toBe(202);
      expect((await request(nodes[1]!, '/api/wagering/transactions', bet)).status).toBe(201);
      await waitFor(
        async () =>
          (
            await request(
              nodes[2]!,
              `/api/wagering/transactions/${String(refund.body.transactionId)}`,
            )
          ).body.status === 'PROCESSED',
      );
      const event = await orm.em.fork().findOneOrFail(OutboxMessageEntity, {
        aggregateId: String(refund.body.transactionId),
        eventType: 'WagerTransactionProcessed',
      });
      expect(event.payload.correlationId).toBe('distributed-trace');
      expect(
        await orm.em
          .fork()
          .count(WalletLedgerEntryEntity, { transactionId: String(refund.body.transactionId) }),
      ).toBe(1);
      await assertBalance(w, '100.00');
    }, 20_000);

    test('SIGKILL after commit before ack permits safe redelivery in a replacement process', async () => {
      const w = await wallet();
      const marker = join(directory, 'before-ack');
      const doomed = await start({
        SQS_CONSUMER_ENABLED: 'true',
        OUTBOX_WORKER_ENABLED: 'false',
        TEST_PAUSE_BEFORE_ACK_FILE: marker,
      });
      const messageId = randomUUID();
      const data = { ...command(w), idempotencyKey: randomUUID() };
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageGroupId: w.id,
          MessageDeduplicationId: messageId,
          MessageBody: JSON.stringify({
            messageId,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data,
          }),
        }),
      );
      await waitFor(async () => {
        try {
          await access(marker);
          return true;
        } catch {
          return false;
        }
      });
      expect(await orm.em.fork().count(InboxMessageEntity, { messageId })).toBe(1);
      await assertBalance(w, '75.00');
      await stop(doomed, true);
      const replacement = await start({
        SQS_CONSUMER_ENABLED: 'true',
        OUTBOX_WORKER_ENABLED: 'false',
      });
      await waitFor(async () =>
        (await (await fetch(`${replacement.base}/metrics`)).text()).includes(
          'wager_duplicates_total{source="sqs"} 1',
        ),
      );
      expect(
        await orm.em
          .fork()
          .count(WalletLedgerEntryEntity, { walletId: w.id, direction: LedgerDirection.Debit }),
      ).toBe(1);
      expect(await orm.em.fork().count(InboxMessageEntity, { messageId })).toBe(1);
      await assertBalance(w, '75.00');
    }, 40_000);

    test('restarts three instances and publishes all confirmed events with consistent balances', async () => {
      const last = await wallet();
      await Promise.all(allNodes.map((node) => stop(node)));
      nodes = await Promise.all([
        start({ OUTBOX_WORKER_INTERVAL_MS: '100' }),
        start({ OUTBOX_WORKER_INTERVAL_MS: '100' }),
        start({ OUTBOX_WORKER_INTERVAL_MS: '100' }),
      ]);
      const ids = [...wallets.keys()];
      const transactions = await orm.em
        .fork()
        .find(WagerTransactionEntity, { walletId: { $in: ids } });
      const aggregateIds = [...ids, ...transactions.map((transaction) => transaction.id)];
      await waitFor(
        async () =>
          (await orm.em.fork().count(OutboxMessageEntity, {
            aggregateId: { $in: aggregateIds },
            publishedAt: null,
          })) === 0,
      );
      for (const [id, amount] of wallets) {
        const state = await request(nodes[0]!, `/api/wallets/${id}`);
        if (typeof state.body.playerId !== 'string') throw new Error('Missing player');
        await assertBalance({ id, playerId: state.body.playerId }, amount);
      }
      await assertBalance(last, '100.00');
      const expected = await orm.em
        .fork()
        .find(OutboxMessageEntity, { aggregateId: { $in: aggregateIds } });
      const received = new Set<string>();
      await waitFor(async () => {
        const result = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: eventsUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );
        for (const message of result.Messages ?? []) {
          const value: unknown = JSON.parse(message.Body!);
          if (
            value !== null &&
            typeof value === 'object' &&
            'eventId' in value &&
            typeof value.eventId === 'string'
          )
            received.add(value.eventId);
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: eventsUrl,
              ReceiptHandle: message.ReceiptHandle!,
            }),
          );
        }
        return expected.every((event) => received.has(event.id));
      });
      expect(expected.every((event) => received.has(event.id))).toBe(true);
    }, 60_000);
  },
);
