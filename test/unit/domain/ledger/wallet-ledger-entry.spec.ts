import { describe, expect, it } from 'bun:test';

import { LedgerDirection } from '../../../../src/domain/ledger/ledger-direction';
import {
  InvalidLedgerAmountError,
  InvalidLedgerBalanceError,
  InvalidLedgerTimestampError,
  LedgerCurrencyMismatchError,
  UnbalancedLedgerEntryError,
  WalletLedgerEntry,
  type CreateWalletLedgerEntryProps,
} from '../../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../../src/domain/shared/value-objects/money';
import { Wallet } from '../../../../src/domain/wallet/wallet';

const entryId = '0192f2a0-46f1-7f80-935b-e112cc2aa3b0';
const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const transactionId = '0192f298-345e-7e38-af88-e43f851a819d';
const createdAt = new Date('2026-10-14T10:01:00.000Z');

function money(amount: string, currency = 'BRL'): Money {
  return Money.from({ amount, currency });
}

function creditProps(
  overrides: Partial<CreateWalletLedgerEntryProps> = {},
): CreateWalletLedgerEntryProps {
  return {
    id: entryId,
    walletId,
    transactionId,
    direction: LedgerDirection.Credit,
    money: money('25.00'),
    balanceBefore: money('100.00'),
    balanceAfter: money('125.00'),
    createdAt,
    ...overrides,
  };
}

describe('WalletLedgerEntry', () => {
  describe('create', () => {
    it('creates a balanced credit entry', () => {
      const entry = WalletLedgerEntry.create(creditProps());

      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(entry.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(entry.balanceAfter.toJSON()).toEqual({ amount: '125.00', currency: 'BRL' });
      expect(entry.isBalanced()).toBe(true);
    });

    it('creates a balanced debit entry', () => {
      const entry = WalletLedgerEntry.create(
        creditProps({
          direction: LedgerDirection.Debit,
          balanceAfter: money('75.00'),
        }),
      );

      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.isBalanced()).toBe(true);
    });

    it('creates an opening credit from zero without changing wallet version semantics', () => {
      const entry = WalletLedgerEntry.create(
        creditProps({
          money: money('100.00'),
          balanceBefore: Money.zero('BRL'),
          balanceAfter: money('100.00'),
        }),
      );

      expect(entry.isBalanced()).toBe(true);
      expect(entry.balanceBefore.isZero()).toBe(true);
    });

    it.each([
      {
        direction: LedgerDirection.Credit,
        balanceAfter: money('124.99'),
      },
      {
        direction: LedgerDirection.Debit,
        balanceAfter: money('75.01'),
      },
    ])('rejects an unbalanced $direction entry', ({ direction, balanceAfter }) => {
      expect(() => WalletLedgerEntry.create(creditProps({ direction, balanceAfter }))).toThrow(
        UnbalancedLedgerEntryError,
      );
    });

    it('rejects different currencies among amount and balances', () => {
      expect(() =>
        WalletLedgerEntry.create(
          creditProps({
            money: money('25.00', 'USD'),
          }),
        ),
      ).toThrow(LedgerCurrencyMismatchError);
    });

    it.each([Money.zero('BRL'), money('1.00').negate()])(
      'rejects a non-positive ledger amount',
      (invalidAmount) => {
        expect(() => WalletLedgerEntry.create(creditProps({ money: invalidAmount }))).toThrow(
          InvalidLedgerAmountError,
        );
      },
    );

    it.each([{ balanceBefore: money('1.00').negate() }, { balanceAfter: money('1.00').negate() }])(
      'rejects a negative ledger balance',
      (overrides) => {
        expect(() => WalletLedgerEntry.create(creditProps(overrides))).toThrow(
          InvalidLedgerBalanceError,
        );
      },
    );

    it('rejects an invalid timestamp', () => {
      expect(() =>
        WalletLedgerEntry.create(creditProps({ createdAt: new Date('invalid') })),
      ).toThrow(InvalidLedgerTimestampError);
    });
  });

  describe('fromBalanceChange', () => {
    it('creates a ledger entry directly from a wallet movement', () => {
      const wallet = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: money('100.00'),
        createdAt: new Date('2026-10-14T10:00:00.000Z'),
      });
      const change = wallet.debit(money('30.00'), createdAt);

      const entry = WalletLedgerEntry.fromBalanceChange({
        id: entryId,
        transactionId,
        change,
      });

      expect(entry.walletId).toBe(walletId);
      expect(entry.transactionId).toBe(transactionId);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(entry.balanceAfter.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
      expect(entry.createdAt).toEqual(createdAt);
      expect(entry.isBalanced()).toBe(true);
    });
  });

  describe('rehydrate', () => {
    it('reconstructs persisted state without applying creation validation', () => {
      const entry = WalletLedgerEntry.rehydrate(
        creditProps({
          balanceAfter: money('999.00'),
        }),
      );

      expect(entry.balanceAfter.toJSON()).toEqual({ amount: '999.00', currency: 'BRL' });
      expect(entry.isBalanced()).toBe(false);
    });
  });

  describe('immutability', () => {
    it('freezes the entry and protects its internal timestamp', () => {
      const suppliedDate = new Date(createdAt);
      const entry = WalletLedgerEntry.create(creditProps({ createdAt: suppliedDate }));

      suppliedDate.setUTCFullYear(2000);
      entry.createdAt.setUTCFullYear(2001);

      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.createdAt).toEqual(createdAt);
    });
  });
});
