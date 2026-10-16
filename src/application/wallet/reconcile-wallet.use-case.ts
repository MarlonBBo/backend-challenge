import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  WALLET_RECONCILIATION_READER,
  type WalletReconciliationReader,
} from './ports/wallet-reconciliation-reader';
import { ResourceNotFoundError } from '../shared/resource-not-found.error';
import {
  APPLICATION_TELEMETRY,
  NOOP_TELEMETRY,
  type ApplicationTelemetry,
} from '../shared/telemetry';

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(WALLET_RECONCILIATION_READER) private readonly reader: WalletReconciliationReader,
    @Optional()
    @Inject(APPLICATION_TELEMETRY)
    private readonly telemetry: ApplicationTelemetry = NOOP_TELEMETRY,
  ) {}
  async execute(walletId: string) {
    const snapshot = await this.reader.read(walletId);
    if (snapshot === undefined) throw new ResourceNotFoundError('wallet');
    if (!snapshot.consistent) {
      this.telemetry.increment('wallet_reconciliation_divergences_total');
      this.telemetry.event('Wallet reconciliation divergence detected', { walletId });
    }
    const money = (amount: string) => Object.freeze({ amount, currency: snapshot.currency });
    return Object.freeze({
      walletId: snapshot.walletId,
      storedBalance: money(snapshot.storedBalance),
      calculatedBalance: money(snapshot.calculatedBalance),
      difference: money(snapshot.difference),
      consistent: snapshot.consistent,
      checkedEntries: snapshot.checkedEntries,
      currencyMismatchEntries: snapshot.currencyMismatchEntries,
      checkedAt: snapshot.checkedAt,
    });
  }
}
