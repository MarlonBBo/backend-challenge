import { Module } from '@nestjs/common';

import { MikroOrmWageringUnitOfWork } from '../../infrastructure/database/unit-of-work/mikro-orm-wagering.unit-of-work';
import { WageringController } from '../../presentation/http/wagering.controller';
import { WAGERING_UNIT_OF_WORK } from './ports/wagering-unit-of-work';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';

@Module({
  controllers: [WageringController],
  providers: [
    ProcessWagerTransactionUseCase,
    MikroOrmWageringUnitOfWork,
    {
      provide: WAGERING_UNIT_OF_WORK,
      useExisting: MikroOrmWageringUnitOfWork,
    },
  ],
})
export class WageringModule {}
