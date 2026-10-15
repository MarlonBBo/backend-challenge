import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', type: 'string', length: 100 })
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at', columnType: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'integer' })
  attempts = 0;

  @Property({ fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true })
  nextAttemptAt: Date | null = null;

  @Property({ fieldName: 'published_at', columnType: 'timestamptz', nullable: true })
  publishedAt: Date | null = null;
}
