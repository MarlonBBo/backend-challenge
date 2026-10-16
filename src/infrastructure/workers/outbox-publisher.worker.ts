import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { PublishOutboxBatchUseCase } from '../../application/messaging/publish-outbox-batch.use-case';
import {
  INTEGRATION_EVENT_PUBLISHER,
  type IntegrationEventPublisher,
} from '../../application/messaging/ports/integration-event-publisher';
import { ApplicationMetrics } from '../observability/application.metrics';

export const OUTBOX_WORKER_OPTIONS = Symbol('OUTBOX_WORKER_OPTIONS');
export interface OutboxWorkerOptions {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly batchSize: number;
}

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopping = false;
  private readonly counters = {
    attempted: 0,
    published: 0,
    failed: 0,
    batchFailures: 0,
    pending: 0,
    oldestPendingAgeMs: 0,
  };

  constructor(
    @Inject(PublishOutboxBatchUseCase)
    private readonly publishBatch: Pick<PublishOutboxBatchUseCase, 'execute'>,
    @Inject(INTEGRATION_EVENT_PUBLISHER) private readonly publisher: IntegrationEventPublisher,
    @Inject(OUTBOX_WORKER_OPTIONS) private readonly options: OutboxWorkerOptions,
    @Optional() @Inject(ApplicationMetrics) private readonly exposedMetrics?: ApplicationMetrics,
  ) {}

  get metrics(): Readonly<typeof this.counters> {
    return Object.freeze({ ...this.counters });
  }

  onApplicationBootstrap(): void {
    if (this.options.enabled) this.schedule();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.running;
    this.publisher.close();
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.running = this.runBatch().finally(() => this.schedule());
    }, this.options.intervalMs);
  }

  private async runBatch(): Promise<void> {
    try {
      const result = await this.publishBatch.execute(this.options.batchSize, () => this.stopping);
      this.counters.attempted += result.published + result.failed;
      this.counters.published += result.published;
      this.counters.failed += result.failed;
      this.counters.pending = result.pending;
      this.counters.oldestPendingAgeMs = result.oldestPendingAgeMs;
      this.exposedMetrics?.increment('outbox_published_total', {}, result.published);
      this.exposedMetrics?.increment('wager_retries_total', { worker: 'outbox' }, result.failed);
      this.exposedMetrics?.gauge('outbox_pending_messages', result.pending);
      this.exposedMetrics?.gauge('outbox_lag_seconds', result.oldestPendingAgeMs / 1000);
      if (result.selected > 0 || result.pending > 0)
        this.logger.log({ message: 'Outbox publication batch committed', ...result });
    } catch {
      this.counters.batchFailures += 1;
      this.exposedMetrics?.increment('outbox_batch_failures_total');
      this.logger.error('Outbox batch failed; uncommitted events remain available for retry');
    }
  }
}
