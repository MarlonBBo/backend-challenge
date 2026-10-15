import type { EntityManager } from '@mikro-orm/postgresql';

import type { InboxDelivery } from '../../../application/wagering/ports/inbox-delivery';
import type { InboxMessage } from '../../../domain/messaging/inbox-message';
import { InboxMessageEntity } from '../entities/inbox-message.entity';
import { InboxMessageMapper } from '../mappers/inbox-message.mapper';

export class InboxMessageRepository {
  async receive(entityManager: EntityManager, delivery: InboxDelivery): Promise<InboxMessage> {
    // Uma transação duplicada aguarda a confirmação simultânea. Se essa transação for revertida,
    // esta inserção é bem-sucedida e a mensagem pode ser processada normalmente.
    await entityManager.execute(
      `
      insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
      values (?, ?, ?, ?) on conflict (consumer_name, message_id) do nothing
    `,
      [delivery.consumerName, delivery.messageId, delivery.payloadHash, new Date()],
    );
    const entity = await entityManager.findOneOrFail(
      InboxMessageEntity,
      {
        consumerName: delivery.consumerName,
        messageId: delivery.messageId,
      },
      { refresh: true },
    );
    return InboxMessageMapper.toDomain(entity);
  }

  async complete(entityManager: EntityManager, message: InboxMessage): Promise<void> {
    await entityManager.nativeUpdate(
      InboxMessageEntity,
      {
        consumerName: message.consumerName,
        messageId: message.messageId,
      },
      { processedAt: message.processedAt },
    );
  }
}
