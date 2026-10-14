import { IntegrationEvent, type EventContext } from './integration-event';
import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { LedgerDirection } from '../ledger/ledger-direction';
import type { MoneyProps } from '../shared/value-objects/money';
import type { Wallet } from '../wallet/wallet';
import { InvalidEventSourceError } from './wagering-events';

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Readonly<MoneyProps>;
  readonly balanceBefore: Readonly<MoneyProps>;
  readonly balanceAfter: Readonly<MoneyProps>;
  readonly walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext) {
    if (
      entry.walletId !== wallet.id ||
      entry.balanceAfter.currency !== wallet.currency ||
      !entry.balanceAfter.equals(wallet.balance)
    ) {
      throw new InvalidEventSourceError('Ledger entry does not represent the current wallet state');
    }

    super({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(wallet, entry, context);
  }
}
