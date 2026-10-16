import { describe, expect, mock, test } from 'bun:test';
import { PublishOutboxBatchUseCase } from '../../../../src/application/messaging/publish-outbox-batch.use-case';
import type { OutboxUnitOfWork } from '../../../../src/application/messaging/ports/outbox-unit-of-work';
import { OutboxMessage } from '../../../../src/domain/messaging/outbox-message';

function message(id = 'event-1'): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId: 'aggregate',
    eventType: 'TestEvent',
    payload: { eventId: id },
    occurredAt: new Date(Date.now() - 10_000),
    attempts: 0,
  });
}

function fixture(messages = [message()]) {
  const save = mock(() => Promise.resolve());
  const unitOfWork: OutboxUnitOfWork = {
    executeBatch: (now, limit, work) =>
      work({ messages: messages.filter((entry) => entry.isDue(now)).slice(0, limit), save }),
    pendingMetrics: () =>
      Promise.resolve({
        pending: messages.filter((entry) => entry.isPending()).length,
        oldestPendingAgeMs: 0,
      }),
  };
  const publisher = { publish: mock(() => Promise.resolve()), close: mock(() => {}) };
  return {
    messages,
    save,
    unitOfWork,
    publisher,
    useCase: new PublishOutboxBatchUseCase(unitOfWork, publisher),
  };
}

describe('PublishOutboxBatchUseCase', () => {
  test('publishes the persisted event and never selects a published message again', async () => {
    const { useCase, publisher, messages } = fixture();
    const result = await useCase.execute(25);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.pending).toBe(0);
    expect(result.events[0]?.eventId).toBe('event-1');
    expect(result.events[0]!.lagMs).toBeGreaterThanOrEqual(10_000);
    expect(messages[0]?.publishedAt).toBeDefined();
    expect((await useCase.execute(25)).selected).toBe(0);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  test('a send failure schedules backoff while the remaining messages can publish', async () => {
    const { useCase, publisher, messages } = fixture([message('failed'), message('success')]);
    publisher.publish.mockRejectedValueOnce(new Error('SQS unavailable'));
    const before = Date.now();
    const result = await useCase.execute(25);
    expect(result.failed).toBe(1);
    expect(result.published).toBe(1);
    expect(result.pending).toBe(1);
    expect(messages[0]?.attempts).toBe(1);
    expect(messages[0]?.publishedAt).toBeUndefined();
    expect(messages[0]!.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 1_000);
    expect(result.events[0]?.failedAttempts).toBe(1);
    expect((await useCase.execute(25)).selected).toBe(0);
  });

  test('database failures propagate to roll back the batch instead of becoming send failures', async () => {
    const { useCase, publisher, save } = fixture();
    save.mockRejectedValueOnce(new Error('database write failed'));
    expect(useCase.execute(1)).rejects.toThrow('database write failed');
    await Bun.sleep(1);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  test('shutdown finishes the current send but starts no further messages in the batch', async () => {
    const { useCase, publisher, messages } = fixture([message('first'), message('second')]);
    let stopping = false;
    publisher.publish.mockImplementation(() => {
      stopping = true;
      return Promise.resolve();
    });
    const result = await useCase.execute(25, () => stopping);
    expect(result.published).toBe(1);
    expect(result.pending).toBe(1);
    expect(messages[1]?.publishedAt).toBeUndefined();
  });
});
