import { describe, expect, mock, test } from 'bun:test';
import { OutboxPublisherWorker } from '../../../../src/infrastructure/workers/outbox-publisher.worker';

const result = {
  selected: 1,
  published: 1,
  failed: 0,
  pending: 0,
  oldestPendingAgeMs: 0,
  events: [],
};
const options = { enabled: true, intervalMs: 1, batchSize: 25 };

describe('OutboxPublisherWorker', () => {
  test('retries the next cycle after a failed batch', async () => {
    let recovered!: () => void;
    const recovery = new Promise<void>((resolve) => {
      recovered = resolve;
    });
    const execute = mock(() => {
      recovered();
      return Promise.resolve(result);
    }).mockRejectedValueOnce(new Error('database unavailable'));
    const worker = new OutboxPublisherWorker(
      { execute },
      { publish: () => Promise.resolve(), close: () => {} },
      options,
    );
    worker.onApplicationBootstrap();
    await recovery;
    await worker.beforeApplicationShutdown();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(worker.metrics.batchFailures).toBe(1);
    expect(worker.metrics.published).toBe(1);
  });
  test('disabled worker does not publish', async () => {
    const execute = mock(() => Promise.resolve(result));
    const close = mock(() => {});
    const worker = new OutboxPublisherWorker(
      { execute },
      { publish: () => Promise.resolve(), close },
      { ...options, enabled: false },
    );
    worker.onApplicationBootstrap();
    await Bun.sleep(10);
    await worker.beforeApplicationShutdown();
    expect(execute).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('shutdown awaits the batch and records committed metrics before closing the publisher', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entering = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execute = mock(async () => {
      started();
      await gate;
      return result;
    });
    const close = mock(() => {});
    const worker = new OutboxPublisherWorker(
      { execute },
      { publish: () => Promise.resolve(), close },
      options,
    );
    worker.onApplicationBootstrap();
    await entering;
    const stopping = worker.beforeApplicationShutdown();
    try {
      await Bun.sleep(10);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
    } finally {
      release();
      await stopping;
    }
    expect(close).toHaveBeenCalledTimes(1);
    expect(worker.metrics.published).toBe(1);
    expect(worker.metrics.attempted).toBe(1);
    expect(worker.metrics.batchFailures).toBe(0);
  });
});
