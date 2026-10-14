export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  readonly aggregateId: string;
  readonly data: T;
}

export interface IntegrationEventEnvelope<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: Readonly<T>;
}

export class InvalidEventTimestampError extends Error {
  readonly code = 'INVALID_EVENT_TIMESTAMP';

  constructor() {
    super('An integration event timestamp must be a valid date');
    this.name = 'InvalidEventTimestampError';
  }
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: Readonly<T>;

  private readonly _occurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    if (Number.isNaN(props.occurredAt.getTime())) {
      throw new InvalidEventTimestampError();
    }

    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this._occurredAt = new Date(props.occurredAt);
    this.data = Object.freeze(props.data);
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt);
  }

  toJSON(): Readonly<IntegrationEventEnvelope<T>> {
    return Object.freeze({
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    });
  }
}
