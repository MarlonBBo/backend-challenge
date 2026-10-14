import { LedgerDirection } from './ledger-direction';
import type { Money } from '../shared/value-objects/money';
import type { WalletBalanceChange } from '../wallet/wallet';

export interface CreateWalletLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export interface CreateWalletLedgerEntryFromChangeProps {
  readonly id: string;
  readonly transactionId: string;
  readonly change: WalletBalanceChange;
}

export type WalletLedgerEntryState = CreateWalletLedgerEntryProps;

export class InvalidLedgerAmountError extends Error {
  readonly code = 'INVALID_LEDGER_AMOUNT';

  constructor() {
    super('A ledger entry amount must be positive');
    this.name = 'InvalidLedgerAmountError';
  }
}

export class InvalidLedgerBalanceError extends Error {
  readonly code = 'INVALID_LEDGER_BALANCE';

  constructor() {
    super('A ledger entry cannot contain a negative balance');
    this.name = 'InvalidLedgerBalanceError';
  }
}

export class LedgerCurrencyMismatchError extends Error {
  readonly code = 'LEDGER_CURRENCY_MISMATCH';

  constructor() {
    super('Ledger entry amount and balances must use the same currency');
    this.name = 'LedgerCurrencyMismatchError';
  }
}

export class UnbalancedLedgerEntryError extends Error {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';

  constructor() {
    super('Ledger entry arithmetic is not balanced');
    this.name = 'UnbalancedLedgerEntryError';
  }
}

export class InvalidLedgerTimestampError extends Error {
  readonly code = 'INVALID_LEDGER_TIMESTAMP';

  constructor() {
    super('A ledger entry timestamp must be a valid date');
    this.name = 'InvalidLedgerTimestampError';
  }
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerAmountError();
    }

    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerBalanceError();
    }

    if (!WalletLedgerEntry.hasMatchingCurrencies(props)) {
      throw new LedgerCurrencyMismatchError();
    }

    if (!WalletLedgerEntry.hasValidTimestamp(props.createdAt)) {
      throw new InvalidLedgerTimestampError();
    }

    const entry = WalletLedgerEntry.build(props);

    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError();
    }

    return entry;
  }

  static fromBalanceChange(props: CreateWalletLedgerEntryFromChangeProps): WalletLedgerEntry {
    return WalletLedgerEntry.create({
      id: props.id,
      walletId: props.change.walletId,
      transactionId: props.transactionId,
      direction: props.change.direction,
      money: props.change.money,
      balanceBefore: props.change.balanceBefore,
      balanceAfter: props.change.balanceAfter,
      createdAt: new Date(props.change.occurredAt),
    });
  }

  /** Reconstrói o estado persistido confiável sem reexecutar as regras de criação. */
  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  isBalanced(): boolean {
    if (!WalletLedgerEntry.hasMatchingCurrencies(this)) {
      return false;
    }

    const expectedBalance =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expectedBalance.equals(this.balanceAfter);
  }

  private static build(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt),
    );
  }

  private static hasMatchingCurrencies(props: {
    readonly money: Money;
    readonly balanceBefore: Money;
    readonly balanceAfter: Money;
  }): boolean {
    return (
      props.money.currency === props.balanceBefore.currency &&
      props.money.currency === props.balanceAfter.currency
    );
  }

  private static hasValidTimestamp(timestamp: Date): boolean {
    return !Number.isNaN(timestamp.getTime());
  }
}
