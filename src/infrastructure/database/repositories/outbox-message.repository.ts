import type { EntityManager } from '@mikro-orm/postgresql';
import { LockMode, QueryOrder } from '@mikro-orm/core';

import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { OutboxMessageMapper } from '../mappers/outbox-message.mapper';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';
import type { OutboxPendingMetrics } from '../../../application/messaging/ports/outbox-unit-of-work';

export class OutboxMessageRepository {
  async findDueForUpdate(
    entityManager: EntityManager,
    now: Date,
    limit: number,
  ): Promise<readonly OutboxMessage[]> {
    const entities = await entityManager.find(
      OutboxMessageEntity,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        limit,
        orderBy: { occurredAt: QueryOrder.ASC, id: QueryOrder.ASC },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        refresh: true,
      },
    );
    return entities.map((entity) => OutboxMessageMapper.toDomain(entity));
  }

  async update(entityManager: EntityManager, message: OutboxMessage): Promise<void> {
    const affectedRows = await entityManager.nativeUpdate(
      OutboxMessageEntity,
      { id: message.id, publishedAt: null },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      },
    );
    if (affectedRows !== 1)
      throw new Error(`Outbox message ${message.id} changed while being published`);
  }

  async pendingMetrics(entityManager: EntityManager, now: Date): Promise<OutboxPendingMetrics> {
    const rows = await entityManager.execute<{ pending: number; oldest_pending_age_ms: number }[]>(
      `
      select count(*)::int as pending,
        coalesce(extract(epoch from (?::timestamptz - min(occurred_at))) * 1000, 0)::double precision as oldest_pending_age_ms
      from outbox_messages where published_at is null
    `,
      [now],
    );
    return {
      pending: rows[0]!.pending,
      oldestPendingAgeMs: Math.max(0, rows[0]!.oldest_pending_age_ms),
    };
  }

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
