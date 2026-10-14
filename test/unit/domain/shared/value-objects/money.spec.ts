import { describe, expect, it } from 'bun:test';

import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
  Money,
  MoneyOverflowError,
} from '../../../../../src/domain/shared/value-objects/money';

describe('Money', () => {
  describe('creation and serialization', () => {
    it('creates money from a canonical decimal string', () => {
      const money = Money.from({ amount: '25.00', currency: 'BRL' });

      expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(money.toString()).toBe('25.00 BRL');
    });

    it('creates zero with a fixed scale', () => {
      const money = Money.zero('BRL');

      expect(money.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(money.isZero()).toBe(true);
      expect(money.isPositive()).toBe(false);
      expect(money.isNegative()).toBe(false);
    });

    it.each([
      '',
      ' ',
      'NaN',
      'Infinity',
      '-1.00',
      '+1.00',
      '1e2',
      '1',
      '1.0',
      '1.000',
      '.50',
      '01.00',
      ' 1.00',
      '1.00 ',
    ])('rejects the non-canonical amount %p', (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
    });

    it('rejects rather than rounds an amount with more than two decimal places', () => {
      expect(() => Money.from({ amount: '10.005', currency: 'BRL' })).toThrow(
        InvalidMoneyAmountError,
      );
    });

    it.each(['brl', 'BrL', 'BR', 'BRLL', '', ' BRL'])(
      'rejects the invalid currency %p',
      (currency) => {
        expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidCurrencyError);
      },
    );

    it('rejects an amount larger than numeric(20,2)', () => {
      expect(() => Money.from({ amount: '1000000000000000000.00', currency: 'BRL' })).toThrow(
        InvalidMoneyAmountError,
      );
    });
  });

  describe('arithmetic', () => {
    it('adds decimal values exactly without floating-point errors', () => {
      const first = Money.from({ amount: '0.10', currency: 'BRL' });
      const second = Money.from({ amount: '0.20', currency: 'BRL' });

      expect(first.add(second).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    });

    it('subtracts without mutating either operand', () => {
      const balance = Money.from({ amount: '100.00', currency: 'BRL' });
      const bet = Money.from({ amount: '25.00', currency: 'BRL' });

      const result = balance.subtract(bet);

      expect(result.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(bet.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    });

    it('allows an internal arithmetic result to be negative', () => {
      const difference = Money.from({ amount: '10.00', currency: 'BRL' }).subtract(
        Money.from({ amount: '15.00', currency: 'BRL' }),
      );

      expect(difference.toJSON()).toEqual({ amount: '-5.00', currency: 'BRL' });
      expect(difference.isNegative()).toBe(true);
    });

    it('negates a value without mutating the original', () => {
      const money = Money.from({ amount: '12.50', currency: 'BRL' });

      expect(money.negate().toJSON()).toEqual({ amount: '-12.50', currency: 'BRL' });
      expect(money.toJSON()).toEqual({ amount: '12.50', currency: 'BRL' });
    });

    it('rejects an arithmetic result larger than numeric(20,2)', () => {
      const maximum = Money.from({ amount: '999999999999999999.99', currency: 'BRL' });

      expect(() => maximum.add(Money.from({ amount: '0.01', currency: 'BRL' }))).toThrow(
        MoneyOverflowError,
      );
    });
  });

  describe('comparison', () => {
    it('compares values exactly', () => {
      const smaller = Money.from({ amount: '9.99', currency: 'BRL' });
      const larger = Money.from({ amount: '10.00', currency: 'BRL' });

      expect(smaller.isLessThan(larger)).toBe(true);
      expect(larger.isLessThan(smaller)).toBe(false);
      expect(larger.equals(Money.from({ amount: '10.00', currency: 'BRL' }))).toBe(true);
      expect(larger.isPositive()).toBe(true);
    });
  });

  describe('currency safety', () => {
    it.each([
      (left: Money, right: Money) => left.add(right),
      (left: Money, right: Money) => left.subtract(right),
      (left: Money, right: Money) => left.isLessThan(right),
      (left: Money, right: Money) => left.equals(right),
    ])('rejects operations between different currencies', (operation) => {
      const brl = Money.from({ amount: '10.00', currency: 'BRL' });
      const usd = Money.from({ amount: '10.00', currency: 'USD' });

      expect(() => operation(brl, usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe('immutability', () => {
    it('freezes the value object and serialized representation', () => {
      const money = Money.from({ amount: '10.00', currency: 'BRL' });
      const serialized = money.toJSON();

      expect(Object.isFrozen(money)).toBe(true);
      expect(Object.isFrozen(serialized)).toBe(true);
    });
  });
});
