import type { OutboxMessage } from '../../../domain/messaging/outbox-message';

export const OUTBOX_UNIT_OF_WORK = Symbol('OUTBOX_UNIT_OF_WORK');

export interface OutboxBatchContext {
  readonly messages: readonly OutboxMessage[];
  save(message: OutboxMessage): Promise<void>;
}

export interface OutboxPendingMetrics {
  readonly pending: number;
  readonly oldestPendingAgeMs: number;
}

export interface OutboxUnitOfWork {
  executeBatch<T>(
    now: Date,
    limit: number,
    work: (context: OutboxBatchContext) => Promise<T>,
  ): Promise<T>;
  pendingMetrics(now: Date): Promise<OutboxPendingMetrics>;
}
