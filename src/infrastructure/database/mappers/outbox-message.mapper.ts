import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';

export class OutboxMessageMapper {
  static toEntity(message: OutboxMessage): OutboxMessageEntity {
    const entity = new OutboxMessageEntity();
    entity.id = message.id;
    entity.aggregateId = message.aggregateId;
    entity.eventType = message.eventType;
    entity.payload = { ...message.payload };
    entity.occurredAt = message.occurredAt;
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt ?? null;
    entity.publishedAt = message.publishedAt ?? null;
    return entity;
  }

  static toDomain(entity: OutboxMessageEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: entity.id,
      aggregateId: entity.aggregateId,
      eventType: entity.eventType,
      payload: entity.payload,
      occurredAt: entity.occurredAt,
      attempts: entity.attempts,
      nextAttemptAt: entity.nextAttemptAt ?? undefined,
      publishedAt: entity.publishedAt ?? undefined,
    });
  }
}
