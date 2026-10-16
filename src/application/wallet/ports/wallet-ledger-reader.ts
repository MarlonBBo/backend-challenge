import type { LedgerDirection } from '../../../domain/ledger/ledger-direction';
import type { MoneyProps } from '../../../domain/shared/value-objects/money';

export const WALLET_LEDGER_READER = Symbol('WALLET_LEDGER_READER');

export interface LedgerPosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface LedgerEntryView extends LedgerPosition {
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Readonly<MoneyProps>;
  readonly balanceBefore: Readonly<MoneyProps>;
  readonly balanceAfter: Readonly<MoneyProps>;
}

export interface WalletLedgerReader {
  findPage(
    walletId: string,
    take: number,
    after?: LedgerPosition,
  ): Promise<readonly LedgerEntryView[]>;
}
