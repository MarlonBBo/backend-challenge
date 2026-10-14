import type { EntityManager } from '@mikro-orm/postgresql';

import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { OutboxMessageMapper } from '../mappers/outbox-message.mapper';

export class OutboxMessageRepository {
  async insertMany(
    entityManager: EntityManager,
    messages: readonly OutboxMessage[],
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    entityManager.persist(messages.map((message) => OutboxMessageMapper.toEntity(message)));
    await entityManager.flush();
  }
}
