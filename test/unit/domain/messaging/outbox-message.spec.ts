import { describe, expect, it } from 'bun:test';

import {
  IntegrationEvent,
  type EventContext,
} from '../../../../src/domain/events/integration-event';
import {
  InvalidOutboxMessageError,
  OutboxMessage,
  OutboxMessageAlreadyPublishedError,
} from '../../../../src/domain/messaging/outbox-message';

const occurredAt = new Date('2026-10-14T10:00:00.000Z');

const context: EventContext = {
  eventId: 'event-id',
  correlationId: 'correlation-id',
  occurredAt,
};

class TestIntegrationEvent extends IntegrationEvent<{ readonly value: string }> {
  readonly eventType = 'TestIntegrationEvent';
  readonly version = 1;

  constructor(eventContext: EventContext) {
    super({
      ...eventContext,
      aggregateId: 'aggregate-id',
      data: { value: 'test' },
    });
  }
}

describe('OutboxMessage', () => {
  it('enqueues a pending integration event with an immutable JSON payload', () => {
    const message = OutboxMessage.enqueue(new TestIntegrationEvent(context));

    expect(message.id).toBe('event-id');
    expect(message.aggregateId).toBe('aggregate-id');
    expect(message.eventType).toBe('TestIntegrationEvent');
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(occurredAt)).toBe(true);
    expect(Object.isFrozen(message.payload)).toBe(true);
    expect(Object.isFrozen(message.payload.data)).toBe(true);
  });

  it('schedules exponential retries capped at five minutes', () => {
    const message = OutboxMessage.enqueue(new TestIntegrationEvent(context));

    message.scheduleRetry(occurredAt);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(new Date('2026-10-14T10:00:01.000Z'));
    expect(message.isDue(new Date('2026-10-14T10:00:00.999Z'))).toBe(false);
    expect(message.isDue(new Date('2026-10-14T10:00:01.000Z'))).toBe(true);

    for (let attempt = 2; attempt <= 20; attempt += 1) {
      message.scheduleRetry(occurredAt);
    }

    expect(message.attempts).toBe(20);
    expect(message.nextAttemptAt).toEqual(new Date('2026-10-14T10:05:00.000Z'));
  });

  it('marks a message as published and clears its retry schedule', () => {
    const message = OutboxMessage.enqueue(new TestIntegrationEvent(context));
    message.scheduleRetry(occurredAt);
    const publishedAt = new Date('2026-10-14T10:00:02.000Z');

    message.markPublished(publishedAt);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date('2026-10-14T11:00:00.000Z'))).toBe(false);
    expect(message.publishedAt).toEqual(publishedAt);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(() => message.scheduleRetry(publishedAt)).toThrow(OutboxMessageAlreadyPublishedError);
    expect(() => message.markPublished(publishedAt)).toThrow(OutboxMessageAlreadyPublishedError);
  });

  it('rejects invalid timestamps used by transitions', () => {
    const message = OutboxMessage.enqueue(new TestIntegrationEvent(context));

    expect(() => message.isDue(new Date('invalid'))).toThrow(InvalidOutboxMessageError);
    expect(() => message.scheduleRetry(new Date('invalid'))).toThrow(InvalidOutboxMessageError);
    expect(() => message.markPublished(new Date('invalid'))).toThrow(InvalidOutboxMessageError);
  });

  it('rehydrates state and protects every timestamp', () => {
    const nextAttemptAt = new Date('2026-10-14T10:01:00.000Z');
    const message = OutboxMessage.rehydrate({
      id: 'event-id',
      aggregateId: 'aggregate-id',
      eventType: 'Event',
      payload: { nested: { value: true } },
      occurredAt,
      attempts: 3,
      nextAttemptAt,
    });

    message.occurredAt.setUTCFullYear(2000);
    message.nextAttemptAt?.setUTCFullYear(2001);

    expect(message.occurredAt).toEqual(occurredAt);
    expect(message.nextAttemptAt).toEqual(nextAttemptAt);
    expect(Object.isFrozen(message.payload.nested)).toBe(true);
  });
});
