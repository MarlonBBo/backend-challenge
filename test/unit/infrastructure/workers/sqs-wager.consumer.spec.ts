import { describe, expect, mock, test } from 'bun:test';
import { SqsWagerConsumer } from '../../../../src/infrastructure/workers/sqs-wager.consumer';
import type {
  WagerQueue,
  WagerQueueMessage,
} from '../../../../src/infrastructure/messaging/wager-queue';
import {
  parseWagerRequest,
  InvalidWagerMessageError,
} from '../../../../src/infrastructure/messaging/wager-request';
import { WagerIdempotencyConflictError } from '../../../../src/application/wagering/process-wager-transaction.errors';
import { WagerTransactionStatus } from '../../../../src/domain/wagering/wager-transaction';

const options = {
  enabled: true,
  visibilitySeconds: 30,
  heartbeatMs: 5,
  retryBaseSeconds: 1,
  retryMaxSeconds: 300,
};
const request = {
  messageId: 'message-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-10-15T12:00:00Z',
  data: {
    providerId: 'provider',
    externalTransactionId: 'bet',
    idempotencyKey: 'provider:bet',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};
const message: WagerQueueMessage = {
  messageId: 'transport-id',
  receiptHandle: 'receipt',
  body: JSON.stringify(request),
  receiveCount: 1,
  groupId: request.data.walletId,
};
function queue() {
  return {
    receive: mock((): Promise<WagerQueueMessage | undefined> => Promise.resolve(undefined)),
    acknowledge: mock(() => Promise.resolve()),
    changeVisibility: mock(() => Promise.resolve()),
    deadLetter: mock(() => Promise.resolve()),
    close: mock(() => {}),
  } satisfies WagerQueue;
}

describe('SQS wagering consumer', () => {
  test('validates envelope, idempotency key, references and positive amounts', () => {
    expect(parseWagerRequest(message.body).messageId).toBe('message-1');
    for (const body of [
      '{',
      JSON.stringify({ ...request, type: 'Other' }),
      JSON.stringify({ ...request, occurredAt: 'yesterday' }),
      JSON.stringify({ ...request, data: { ...request.data, idempotencyKey: '' } }),
      JSON.stringify({ ...request, data: { ...request.data, kind: 'REFUND' } }),
      JSON.stringify({
        ...request,
        data: { ...request.data, money: { amount: '0.00', currency: 'BRL' } },
      }),
    ]) {
      expect(() => parseWagerRequest(body)).toThrow(InvalidWagerMessageError);
    }
  });

  test('acks only after processing resolves and renews visibility during processing', async () => {
    const transport = queue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = mock(async () => {
      await gate;
      return {
        transactionId: 'transaction',
        status: WagerTransactionStatus.Processed as const,
        idempotentReplay: false,
      };
    });
    const consumer = new SqsWagerConsumer(transport, { execute }, options);
    const handling = consumer.handle(message);
    try {
      await Bun.sleep(20);
      expect(transport.acknowledge).not.toHaveBeenCalled();
      expect(transport.changeVisibility).toHaveBeenCalledWith('receipt', 30);
    } finally {
      release();
      await handling;
    }
    expect(transport.acknowledge).toHaveBeenCalledTimes(1);
  });

  test('acks terminal business rejections', async () => {
    const transport = queue();
    await new SqsWagerConsumer(
      transport,
      {
        execute: () =>
          Promise.resolve({
            transactionId: 'rejected',
            status: WagerTransactionStatus.Rejected,
            idempotentReplay: false,
          }),
      },
      options,
    ).handle(message);
    expect(transport.acknowledge).toHaveBeenCalledTimes(1);
    expect(transport.deadLetter).not.toHaveBeenCalled();
  });

  test('transient failures retry with capped exponential backoff and no ack', async () => {
    const transport = queue();
    const consumer = new SqsWagerConsumer(
      transport,
      { execute: () => Promise.reject(new Error('database unavailable')) },
      options,
    );
    await consumer.handle({ ...message, receiveCount: 3 });
    expect(transport.changeVisibility).toHaveBeenCalledWith('receipt', 4);
    await consumer.handle({ ...message, receiveCount: 20 });
    expect(transport.changeVisibility).toHaveBeenCalledWith('receipt', 300);
    expect(transport.acknowledge).not.toHaveBeenCalled();
  });

  test('permanent errors go to DLQ before ack and a DLQ failure preserves the source', async () => {
    const transport = queue();
    const order: string[] = [];
    transport.deadLetter.mockImplementation(() => {
      order.push('dlq');
      return Promise.resolve();
    });
    transport.acknowledge.mockImplementation(() => {
      order.push('ack');
      return Promise.resolve();
    });
    const consumer = new SqsWagerConsumer(
      transport,
      { execute: () => Promise.reject(new WagerIdempotencyConflictError('key')) },
      options,
    );
    await consumer.handle(message);
    expect(order).toEqual(['dlq', 'ack']);
    transport.acknowledge.mockClear();
    transport.deadLetter.mockImplementation(() => Promise.reject(new Error('DLQ unavailable')));
    expect(consumer.handle({ ...message, body: 'invalid' })).rejects.toThrow('DLQ unavailable');
    await Bun.sleep(5);
    expect(transport.acknowledge).not.toHaveBeenCalled();
  });

  test('shutdown aborts long polling and closes the queue', async () => {
    const close = mock(() => {});
    const transport: WagerQueue = {
      ...queue(),
      close,
      receive: (signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve(undefined), { once: true }),
        ),
    };
    const consumer = new SqsWagerConsumer(
      transport,
      { execute: () => Promise.reject(new Error('unused')) },
      options,
    );
    consumer.onApplicationBootstrap();
    await consumer.beforeApplicationShutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('shutdown drains an in-flight message before closing the client', async () => {
    const transport = queue();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entering = new Promise<void>((resolve) => {
      started = resolve;
    });
    transport.receive.mockResolvedValueOnce(message);
    const consumer = new SqsWagerConsumer(
      transport,
      {
        execute: async () => {
          started();
          await gate;
          return {
            transactionId: 'tx',
            status: WagerTransactionStatus.Processed,
            idempotentReplay: false,
          };
        },
      },
      options,
    );
    consumer.onApplicationBootstrap();
    await entering;
    const stopping = consumer.beforeApplicationShutdown();
    try {
      await Bun.sleep(10);
      expect(transport.acknowledge).not.toHaveBeenCalled();
      expect(transport.close).not.toHaveBeenCalled();
    } finally {
      release();
      await stopping;
    }
    expect(transport.acknowledge).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
});
