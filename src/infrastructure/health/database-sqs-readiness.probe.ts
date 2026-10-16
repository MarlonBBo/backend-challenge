import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { ReadinessProbe } from '../../application/health/readiness-probe';
import { getEnvironment } from '../../config/environment';
import { ApplicationMetrics } from '../observability/application.metrics';

@Injectable()
export class DatabaseSqsReadinessProbe implements ReadinessProbe, OnApplicationShutdown {
  private readonly environment = getEnvironment(process.env);
  private readonly client = new SQSClient({
    region: this.environment.aws.region,
    endpoint: this.environment.aws.sqsEndpoint,
    credentials: {
      accessKeyId: this.environment.aws.accessKeyId,
      secretAccessKey: this.environment.aws.secretAccessKey,
    },
    maxAttempts: 1,
  });
  constructor(
    @Inject(EntityManager) private readonly entityManager: EntityManager,
    @Inject(ApplicationMetrics) private readonly metrics: ApplicationMetrics,
  ) {}
  async database(): Promise<void> {
    const rows = await this.entityManager
      .fork()
      .execute<{ count: number }[]>(
        "select count(*)::int as count from wager_transactions where status = 'PENDING_REFERENCE'",
      );
    this.metrics.gauge('reference_pending_transactions', rows[0]?.count ?? 0);
  }
  async sqs(): Promise<void> {
    await Promise.all(
      [
        this.environment.aws.wagerQueueUrl,
        this.environment.aws.wagerDlqUrl,
        this.environment.aws.eventsQueueUrl,
      ].map(async (QueueUrl) => {
        const result = await this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl,
            AttributeNames: ['QueueArn', 'ApproximateNumberOfMessages'],
          }),
          { abortSignal: AbortSignal.timeout(2_000) },
        );
        if (QueueUrl === this.environment.aws.wagerDlqUrl)
          this.metrics.gauge(
            'sqs_dlq_visible_messages',
            Number(result.Attributes?.ApproximateNumberOfMessages ?? 0),
          );
      }),
    );
  }
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
