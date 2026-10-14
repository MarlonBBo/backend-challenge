import { CurrencyMismatchError, type Money } from '../shared/value-objects/money';
import { LedgerDirection } from '../ledger/ledger-direction';

export interface WalletBalanceChange {
  readonly walletId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly occurredAt: string;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly createdAt?: Date;
}

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class InvalidInitialBalanceError extends Error {
  readonly code = 'INVALID_INITIAL_BALANCE';

  constructor() {
    super('A wallet cannot be opened with a negative balance');
    this.name = 'InvalidInitialBalanceError';
  }
}

export class InvalidWalletMovementError extends Error {
  readonly code = 'INVALID_WALLET_MOVEMENT';

  constructor() {
    super('A wallet movement must have a positive amount');
    this.name = 'InvalidWalletMovementError';
  }
}

export class InsufficientFundsError extends Error {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor() {
    super('The wallet has insufficient funds for this debit');
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidWalletTimestampError extends Error {
  readonly code = 'INVALID_WALLET_TIMESTAMP';

  constructor() {
    super('A wallet timestamp must be a valid date');
    this.name = 'InvalidWalletTimestampError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidInitialBalanceError();
    }

    const createdAt = props.createdAt ?? new Date();
    Wallet.assertValidTimestamp(createdAt);

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(createdAt),
      new Date(createdAt),
    );
  }

  /** Reconstrói o estado persistido confiável sem reexecutar as regras de transição. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(money: Money, at: Date): Readonly<WalletBalanceChange> {
    this.assertCanMove(money, at);

    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError();
    }

    return this.applyBalanceChange(LedgerDirection.Debit, money, at);
  }

  credit(money: Money, at: Date): Readonly<WalletBalanceChange> {
    this.assertCanMove(money, at);
    return this.applyBalanceChange(LedgerDirection.Credit, money, at);
  }

  private applyBalanceChange(
    direction: LedgerDirection,
    money: Money,
    at: Date,
  ): Readonly<WalletBalanceChange> {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? balanceBefore.subtract(money)
        : balanceBefore.add(money);

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(at);

    return Object.freeze({
      walletId: this.id,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version,
      occurredAt: at.toISOString(),
    });
  }

  private assertCanMove(money: Money, at: Date): void {
    this.assertSameCurrency(money);
    Wallet.assertValidTimestamp(at);

    if (!money.isPositive()) {
      throw new InvalidWalletMovementError();
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  private static assertValidTimestamp(timestamp: Date): void {
    if (Number.isNaN(timestamp.getTime())) {
      throw new InvalidWalletTimestampError();
    }
  }
}
