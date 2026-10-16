import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { getEnvironment } from '../../config/environment';
import { MikroOrmOutboxUnitOfWork } from '../../infrastructure/database/unit-of-work/mikro-orm-outbox.unit-of-work';
import { SqsIntegrationEventPublisher } from '../../infrastructure/messaging/sqs-integration-event.publisher';
import {
  OutboxPublisherWorker,
  OUTBOX_WORKER_OPTIONS,
} from '../../infrastructure/workers/outbox-publisher.worker';
import { OUTBOX_UNIT_OF_WORK } from './ports/outbox-unit-of-work';
import { INTEGRATION_EVENT_PUBLISHER } from './ports/integration-event-publisher';
import { PublishOutboxBatchUseCase } from './publish-outbox-batch.use-case';

@Module({
  providers: [
    PublishOutboxBatchUseCase,
    OutboxPublisherWorker,
    MikroOrmOutboxUnitOfWork,
    { provide: OUTBOX_UNIT_OF_WORK, useExisting: MikroOrmOutboxUnitOfWork },
    { provide: OUTBOX_WORKER_OPTIONS, useFactory: () => getEnvironment(process.env).outbox },
    {
      provide: INTEGRATION_EVENT_PUBLISHER,
      useFactory: () => {
        const environment = getEnvironment(process.env);
        return new SqsIntegrationEventPublisher(
          new SQSClient({
            region: environment.aws.region,
            endpoint: environment.aws.sqsEndpoint,
            credentials: {
              accessKeyId: environment.aws.accessKeyId,
              secretAccessKey: environment.aws.secretAccessKey,
            },
            maxAttempts: 3,
          }),
          environment.aws.eventsQueueUrl,
        );
      },
    },
  ],
})
export class OutboxModule {}
