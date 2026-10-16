import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ReconcileWalletUseCase } from '../../application/wallet/reconcile-wallet.use-case';
import { queryIdentifier, queryResponse } from './query-response';

@Controller('wallets')
export class WalletReconciliationController {
  constructor(@Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase) {}
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  execute(@Param('walletId') walletId: string) {
    const id = queryIdentifier(walletId, 'walletId', true);
    return queryResponse(() => this.reconcile.execute(id));
  }
}
