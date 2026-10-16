import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type {
  OutboxUnitOfWork,
  OutboxBatchContext,
  OutboxPendingMetrics,
} from '../../../application/messaging/ports/outbox-unit-of-work';
import { OutboxMessageRepository } from '../repositories/outbox-message.repository';

@Injectable()
export class MikroOrmOutboxUnitOfWork implements OutboxUnitOfWork {
  private readonly repository = new OutboxMessageRepository();
  constructor(private readonly entityManager: EntityManager) {}

  executeBatch<T>(
    now: Date,
    limit: number,
    work: (context: OutboxBatchContext) => Promise<T>,
  ): Promise<T> {
    return this.entityManager.fork().transactional(async (entityManager) =>
      work({
        messages: await this.repository.findDueForUpdate(entityManager, now, limit),
        save: (message) => this.repository.update(entityManager, message),
      }),
    );
  }

  pendingMetrics(now: Date): Promise<OutboxPendingMetrics> {
    return this.repository.pendingMetrics(this.entityManager.fork(), now);
  }
}
