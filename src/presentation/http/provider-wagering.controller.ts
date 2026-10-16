import { Controller, Get, Inject, Param } from '@nestjs/common';
import { GetWagerTransactionUseCase } from '../../application/wagering/get-wager-transaction.use-case';
import { queryIdentifier, queryResponse } from './query-response';

@Controller('providers/:providerId/wagering/transactions')
export class ProviderWageringController {
  constructor(
    @Inject(GetWagerTransactionUseCase) private readonly getTransaction: GetWagerTransactionUseCase,
  ) {}

  @Get(':externalTransactionId')
  get(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const provider = queryIdentifier(providerId, 'providerId');
    const externalId = queryIdentifier(externalTransactionId, 'externalTransactionId');
    return queryResponse(() =>
      this.getTransaction.execute({ providerId: provider, externalTransactionId: externalId }),
    );
  }
}
