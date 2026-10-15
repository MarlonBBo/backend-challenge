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

@Module({
  controllers: [WageringController],
  providers: [
    ProcessWagerTransactionUseCase,
    PendingReferenceWorker,
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
