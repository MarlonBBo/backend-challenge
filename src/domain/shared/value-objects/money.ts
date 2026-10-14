import Decimal from 'decimal.js';

const MONEY_SCALE = 2;
const MAX_INTEGER_DIGITS = 18;
const DECIMAL_AMOUNT_PATTERN = new RegExp(
  `^(?:0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})\\.\\d{${MONEY_SCALE}}$`,
);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyAmountError extends Error {
  readonly code = 'INVALID_MONEY_AMOUNT';

  constructor(amount: unknown) {
    super(`Invalid money amount: ${String(amount)}`);
    this.name = 'InvalidMoneyAmountError';
  }
}

export class InvalidCurrencyError extends Error {
  readonly code = 'INVALID_CURRENCY';

  constructor(currency: unknown) {
    super(`Invalid ISO-4217 currency: ${String(currency)}`);
    this.name = 'InvalidCurrencyError';
  }
}

export class CurrencyMismatchError extends Error {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(leftCurrency: string, rightCurrency: string) {
    super(`Currency mismatch: ${leftCurrency} and ${rightCurrency}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class MoneyOverflowError extends Error {
  readonly code = 'MONEY_OVERFLOW';

  constructor(amount: string) {
    super(`Money amount exceeds numeric(20,2): ${amount}`);
    this.name = 'MoneyOverflowError';
  }
}

/**
 * Valor monetário exato e imutável.
 *
 * A entrada pública é intencionalmente restrita e aceita apenas strings decimais
 * canônicas e não negativas com duas casas decimais. Operações aritméticas podem
 * resultar em um valor negativo; agregações determinam se esse resultado é
 * válido para seus invariantes.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    Money.assertValidCurrency(props.currency);
    Money.assertValidExternalAmount(props.amount);

    return new Money(new MoneyDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(new MoneyDecimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): Readonly<MoneyProps> {
    return Object.freeze({
      amount: this.value.toFixed(MONEY_SCALE),
      currency: this.currency,
    });
  }

  toString(): string {
    return `${this.value.toFixed(MONEY_SCALE)} ${this.currency}`;
  }

  private static fromDecimal(value: Decimal, currency: string): Money {
    const integerDigits = value.abs().trunc().toFixed(0).length;

    if (!value.isFinite() || value.decimalPlaces() > MONEY_SCALE) {
      throw new InvalidMoneyAmountError(value.toString());
    }

    if (integerDigits > MAX_INTEGER_DIGITS) {
      throw new MoneyOverflowError(value.toFixed(MONEY_SCALE));
    }

    return new Money(new MoneyDecimal(value), currency);
  }

  private static assertValidExternalAmount(amount: unknown): asserts amount is string {
    if (typeof amount !== 'string' || !DECIMAL_AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyAmountError(amount);
    }
  }

  private static assertValidCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidCurrencyError(currency);
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
