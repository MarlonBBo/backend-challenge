import { describe, expect, it } from 'bun:test';

import { CurrencyMismatchError, Money } from '../../../../src/domain/shared/value-objects/money';
import { LedgerDirection } from '../../../../src/domain/ledger/ledger-direction';
import {
  InsufficientFundsError,
  InvalidInitialBalanceError,
  InvalidWalletMovementError,
  InvalidWalletTimestampError,
  Wallet,
} from '../../../../src/domain/wallet/wallet';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const openedAt = new Date('2026-10-14T10:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function openWallet(initialBalance = '100.00'): Wallet {
  return Wallet.open({
    id: walletId,
    playerId,
    initialBalance: brl(initialBalance),
    createdAt: openedAt,
  });
}

describe('Wallet', () => {
  describe('open', () => {
    it('opens with the initial balance and version one', () => {
      const wallet = openWallet();

      expect(wallet.id).toBe(walletId);
      expect(wallet.playerId).toBe(playerId);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toEqual(openedAt);
      expect(wallet.updatedAt).toEqual(openedAt);
    });

    it('allows a zero initial balance', () => {
      const wallet = openWallet('0.00');

      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
    });

    it('rejects an internally produced negative initial balance', () => {
      const negativeBalance = brl('10.00').subtract(brl('20.00'));

      expect(() =>
        Wallet.open({
          id: walletId,
          playerId,
          initialBalance: negativeBalance,
          createdAt: openedAt,
        }),
      ).toThrow(InvalidInitialBalanceError);
    });

    it('rejects an invalid creation timestamp', () => {
      expect(() =>
        Wallet.open({
          id: walletId,
          playerId,
          initialBalance: brl('10.00'),
          createdAt: new Date('invalid'),
        }),
      ).toThrow(InvalidWalletTimestampError);
    });
  });

  describe('debit', () => {
    it('debits the balance and increments the version', () => {
      const wallet = openWallet();
      const occurredAt = new Date('2026-10-14T10:01:00.000Z');

      const change = wallet.debit(brl('25.00'), occurredAt);

      expect(wallet.balance.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(occurredAt);
      expect(change.direction).toBe(LedgerDirection.Debit);
      expect(change.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(change.balanceAfter.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(change.walletVersion).toBe(2);
      expect(change.occurredAt).toBe('2026-10-14T10:01:00.000Z');
      expect(Object.isFrozen(change)).toBe(true);
    });

    it('allows debiting the exact available balance', () => {
      const wallet = openWallet();

      wallet.debit(brl('100.00'), new Date('2026-10-14T10:01:00.000Z'));

      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(2);
    });

    it('rejects insufficient funds without changing wallet state', () => {
      const wallet = openWallet();

      expect(() => wallet.debit(brl('100.01'), new Date('2026-10-14T10:01:00.000Z'))).toThrow(
        InsufficientFundsError,
      );
      expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(openedAt);
    });
  });

  describe('credit', () => {
    it('credits the balance and increments the version', () => {
      const wallet = openWallet();
      const occurredAt = new Date('2026-10-14T10:02:00.000Z');

      const change = wallet.credit(brl('50.00'), occurredAt);

      expect(wallet.balance.toJSON()).toEqual({ amount: '150.00', currency: 'BRL' });
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(occurredAt);
      expect(change.direction).toBe(LedgerDirection.Credit);
      expect(change.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(change.balanceAfter.toJSON()).toEqual({ amount: '150.00', currency: 'BRL' });
    });
  });

  describe('movement invariants', () => {
    it.each([
      (wallet: Wallet, money: Money, at: Date) => wallet.debit(money, at),
      (wallet: Wallet, money: Money, at: Date) => wallet.credit(money, at),
    ])('rejects a zero movement without incrementing the version', (move) => {
      const wallet = openWallet();

      expect(() => move(wallet, Money.zero('BRL'), new Date('2026-10-14T10:03:00.000Z'))).toThrow(
        InvalidWalletMovementError,
      );
      expect(wallet.version).toBe(1);
      expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    });

    it.each([
      (wallet: Wallet, money: Money, at: Date) => wallet.debit(money, at),
      (wallet: Wallet, money: Money, at: Date) => wallet.credit(money, at),
    ])('rejects a negative movement without incrementing the version', (move) => {
      const wallet = openWallet();
      const negative = brl('10.00').negate();

      expect(() => move(wallet, negative, new Date('2026-10-14T10:03:00.000Z'))).toThrow(
        InvalidWalletMovementError,
      );
      expect(wallet.version).toBe(1);
      expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    });

    it.each([
      (wallet: Wallet, money: Money, at: Date) => wallet.debit(money, at),
      (wallet: Wallet, money: Money, at: Date) => wallet.credit(money, at),
    ])('rejects a different currency without changing wallet state', (move) => {
      const wallet = openWallet();
      const usd = Money.from({ amount: '10.00', currency: 'USD' });

      expect(() => move(wallet, usd, new Date('2026-10-14T10:03:00.000Z'))).toThrow(
        CurrencyMismatchError,
      );
      expect(wallet.version).toBe(1);
      expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    });

    it('increments once for each successful balance change', () => {
      const wallet = openWallet();

      wallet.debit(brl('10.00'), new Date('2026-10-14T10:01:00.000Z'));
      wallet.credit(brl('20.00'), new Date('2026-10-14T10:02:00.000Z'));

      expect(wallet.version).toBe(3);
      expect(wallet.balance.toJSON()).toEqual({ amount: '110.00', currency: 'BRL' });
    });
  });

  describe('rehydrate', () => {
    it('reconstructs persisted state without replaying transitions', () => {
      const createdAt = new Date('2026-10-01T10:00:00.000Z');
      const updatedAt = new Date('2026-10-14T10:00:00.000Z');

      const wallet = Wallet.rehydrate({
        id: walletId,
        playerId,
        currency: 'BRL',
        balance: brl('275.50'),
        version: 9,
        createdAt,
        updatedAt,
      });

      expect(wallet.balance.toJSON()).toEqual({ amount: '275.50', currency: 'BRL' });
      expect(wallet.version).toBe(9);
      expect(wallet.createdAt).toEqual(createdAt);
      expect(wallet.updatedAt).toEqual(updatedAt);
    });
  });

  describe('date encapsulation', () => {
    it('does not expose mutable internal dates', () => {
      const suppliedDate = new Date(openedAt);
      const wallet = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: brl('100.00'),
        createdAt: suppliedDate,
      });

      suppliedDate.setUTCFullYear(2000);
      wallet.createdAt.setUTCFullYear(2001);
      wallet.updatedAt.setUTCFullYear(2002);

      expect(wallet.createdAt).toEqual(openedAt);
      expect(wallet.updatedAt).toEqual(openedAt);
    });
  });
});
