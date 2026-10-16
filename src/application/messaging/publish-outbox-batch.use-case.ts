import { Inject, Injectable } from '@nestjs/common';
import {
  OUTBOX_UNIT_OF_WORK,
  type OutboxUnitOfWork,
  type OutboxPendingMetrics,
} from './ports/outbox-unit-of-work';
import {
  INTEGRATION_EVENT_PUBLISHER,
  type IntegrationEventPublisher,
} from './ports/integration-event-publisher';

export interface PublishOutboxBatchResult extends OutboxPendingMetrics {
  readonly selected: number;
  readonly published: number;
  readonly failed: number;
  readonly events: readonly {
    readonly eventId: string;
    readonly published: boolean;
    readonly failedAttempts: number;
    readonly lagMs: number;
  }[];
}

@Injectable()
export class PublishOutboxBatchUseCase {
  constructor(
    @Inject(OUTBOX_UNIT_OF_WORK) private readonly unitOfWork: OutboxUnitOfWork,
    @Inject(INTEGRATION_EVENT_PUBLISHER) private readonly publisher: IntegrationEventPublisher,
  ) {}

  async execute(
    limit: number,
    isStopping: () => boolean = () => false,
  ): Promise<PublishOutboxBatchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Outbox batch limit must be between 1 and 100');
    const batch = await this.unitOfWork.executeBatch(new Date(), limit, async (context) => {
      let published = 0;
      let failed = 0;
      const events: PublishOutboxBatchResult['events'][number][] = [];
      for (const message of context.messages) {
        if (isStopping()) break;
        let sent = false;
        try {
          await this.publisher.publish(message);
          sent = true;
        } catch {
          // O envio pode ter sido bem-sucedido no destino; uma nova tentativa deve preservar o eventId.

          message.scheduleRetry(new Date());
          failed += 1;
        }
        if (sent) {
          message.markPublished(new Date());
          published += 1;
        }
        // Uma falha no banco de dados deve resultar em uma
        // reversão (rollback), e não em uma nova tentativa de publicação, nesta transação.
        await context.save(message);
        events.push({
          eventId: message.id,
          published: sent,
          failedAttempts: message.attempts,
          lagMs: Math.max(0, Date.now() - message.occurredAt.getTime()),
        });
      }
      return { selected: context.messages.length, published, failed, events };
    });
    return { ...batch, ...(await this.unitOfWork.pendingMetrics(new Date())) };
  }
}
