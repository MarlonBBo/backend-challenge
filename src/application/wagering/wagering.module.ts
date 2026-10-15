import { Module } from '@nestjs/common';

import { MikroOrmWageringUnitOfWork } from '../../infrastructure/database/unit-of-work/mikro-orm-wagering.unit-of-work';
import { WageringController } from '../../presentation/http/wagering.controller';
import { WAGERING_UNIT_OF_WORK } from './ports/wagering-unit-of-work';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';
import { getEnvironment } from '../../config/environment';
import {
  PendingReferenceWorker,
  REFERENCE_WORKER_OPTIONS,
} from '../../infrastructure/workers/pending-reference.worker';
import { ReferenceRetryPolicy } from './reference-retry-policy';
import type { Environment } from '../../config/environment';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SqsWagerConsumer } from '../../infrastructure/workers/sqs-wager.consumer';
import { SqsWagerQueue } from '../../infrastructure/messaging/sqs-wager.queue';
import { WAGER_QUEUE, SQS_CONSUMER_OPTIONS } from '../../infrastructure/messaging/wager-queue';

@Module({
  controllers: [WageringController],
  providers: [
    ProcessWagerTransactionUseCase,
    PendingReferenceWorker,
    SqsWagerConsumer,
    { provide: SQS_CONSUMER_OPTIONS, useFactory: () => getEnvironment(process.env).sqsConsumer },
    {
      provide: WAGER_QUEUE,
      useFactory: () => {
        const environment = getEnvironment(process.env);
        return new SqsWagerQueue(
          new SQSClient({
            region: environment.aws.region,
            endpoint: environment.aws.sqsEndpoint,
            credentials: {
              accessKeyId: environment.aws.accessKeyId,
              secretAccessKey: environment.aws.secretAccessKey,
            },
            maxAttempts: 3,
          }),
          environment.aws.wagerQueueUrl,
          environment.aws.wagerDlqUrl,
          environment.sqsConsumer.visibilitySeconds,
        );
      },
    },
    { provide: REFERENCE_WORKER_OPTIONS, useFactory: () => getEnvironment(process.env).references },
    {
      provide: ReferenceRetryPolicy,
      inject: [REFERENCE_WORKER_OPTIONS],
      useFactory: (options: Environment['references']) => new ReferenceRetryPolicy(options),
    },
    MikroOrmWageringUnitOfWork,
    {
      provide: WAGERING_UNIT_OF_WORK,
      useExisting: MikroOrmWageringUnitOfWork,
    },
  ],
})
export class WageringModule {}
