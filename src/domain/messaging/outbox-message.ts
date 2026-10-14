import type { IntegrationEvent } from '../events/integration-event';

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1_000;

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
  readonly publishedAt?: Date;
}

export class InvalidOutboxMessageError extends Error {
  readonly code = 'INVALID_OUTBOX_MESSAGE';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutboxMessageError';
  }
}

export class OutboxMessageAlreadyPublishedError extends Error {
  readonly code = 'OUTBOX_MESSAGE_ALREADY_PUBLISHED';

  constructor() {
    super('Published outbox message cannot transition');
    this.name = 'OutboxMessageAlreadyPublishedError';
  }
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    private readonly _occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      cloneAndDeepFreeze(event.toJSON()),
      event.occurredAt,
      0,
    );
  }

  /** Reconstructs trusted persisted state without replaying transition rules. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      cloneAndDeepFreeze(state.payload),
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt === undefined ? undefined : new Date(state.nextAttemptAt),
      state.publishedAt === undefined ? undefined : new Date(state.publishedAt),
    );
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt === undefined ? undefined : new Date(this._nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt === undefined ? undefined : new Date(this._publishedAt);
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    OutboxMessage.assertValidTimestamp(now);
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this.assertPending();
    OutboxMessage.assertValidTimestamp(at);

    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    this.assertPending();
    OutboxMessage.assertValidTimestamp(now);

    this._attempts += 1;
    const exponentialDelay = BASE_RETRY_DELAY_MS * 2 ** (this._attempts - 1);
    const delay = Math.min(exponentialDelay, MAX_RETRY_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new OutboxMessageAlreadyPublishedError();
    }
  }

  private static assertValidTimestamp(timestamp: Date): void {
    if (Number.isNaN(timestamp.getTime())) {
      throw new InvalidOutboxMessageError('Outbox timestamp must be a valid date');
    }
  }
}

function cloneAndDeepFreeze(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(JSON.stringify(payload));

  if (!isRecord(parsed)) {
    throw new InvalidOutboxMessageError('Outbox payload must be a JSON object');
  }

  return deepFreeze(parsed);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue);
    }

    Object.freeze(value);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
