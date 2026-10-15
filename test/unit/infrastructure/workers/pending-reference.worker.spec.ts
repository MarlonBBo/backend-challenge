import { describe, expect, mock, test } from 'bun:test';

import { ProcessWagerTransactionUseCase } from '../../../../src/application/wagering/process-wager-transaction.use-case';
import type { WageringUnitOfWork } from '../../../../src/application/wagering/ports/wagering-unit-of-work';
import { PendingReferenceWorker } from '../../../../src/infrastructure/workers/pending-reference.worker';

const options = {
  enabled: true,
  intervalMs: 1,
  batchSize: 25,
  maxAttempts: 20,
  ttlMs: 86_400_000,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
};

describe('PendingReferenceWorker lifecycle', () => {
  test('disabled worker never schedules processing', async () => {
    const executeNextPending = mock(() => Promise.resolve(undefined));
    const unitOfWork: WageringUnitOfWork = {
      execute: () => Promise.reject(new Error('unused')),
      executeNextPending,
    };
    const worker = new PendingReferenceWorker(new ProcessWagerTransactionUseCase(unitOfWork), {
      ...options,
      enabled: false,
    });
    worker.onApplicationBootstrap();
    await Bun.sleep(10);
    await worker.beforeApplicationShutdown();
    expect(executeNextPending).not.toHaveBeenCalled();
  });

  test('shutdown awaits the in-flight transaction and does not start another tick', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entering = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executeNextPending = mock(async () => {
      started();
      await gate;
      return undefined;
    });
    const unitOfWork: WageringUnitOfWork = {
      execute: () => Promise.reject(new Error('unused')),
      executeNextPending,
    };
    const worker = new PendingReferenceWorker(
      new ProcessWagerTransactionUseCase(unitOfWork),
      options,
    );
    worker.onApplicationBootstrap();
    await entering;
    let stopped = false;
    const stopping = worker.beforeApplicationShutdown().then(() => {
      stopped = true;
    });
    try {
      await Bun.sleep(10);
      expect(stopped).toBe(false);
      expect(executeNextPending).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await stopping;
    }
    await Bun.sleep(10);
    expect(stopped).toBe(true);
    expect(executeNextPending).toHaveBeenCalledTimes(1);
  });
});
