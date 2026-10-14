import { describe, expect, it } from 'bun:test';

import { type EventContext } from '../../../../src/domain/events/integration-event';
import {
  InvalidEventSourceError,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../../src/domain/events/wagering-events';
import { WalletBalanceChanged } from '../../../../src/domain/events/wallet-events';
import { WalletLedgerEntry } from '../../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../../src/domain/shared/value-objects/money';
import { FailureCode } from '../../../../src/domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../../../src/domain/wallet/wallet';

const context: EventContext = {
  eventId: 'event-id',
  correlationId: 'correlation-id',
  causationId: 'causation-id',
  occurredAt: new Date('2026-10-14T10:01:00.000Z'),
};

function bet(): WagerTransaction {
  return WagerTransaction.create({
    id: 'transaction-id',
    providerId: 'provider-a',
    externalTransactionId: 'external-id',
    idempotencyKey: 'provider-a:external-id',
    payloadHash: 'payload-hash',
    walletId: 'wallet-id',
    playerId: 'player-id',
    roundId: 'round-id',
    gameId: 'game-id',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: new Date('2026-10-14T10:00:00.000Z'),
  });
}

describe('integration events', () => {
  it('serializes a processed transaction with a stable typed envelope', () => {
    const transaction = bet();
    transaction.markProcessed(undefined, context.occurredAt);

    const event = WagerTransactionProcessed.from(transaction, context);
    const envelope = event.toJSON();

    expect(envelope.eventType).toBe('WagerTransactionProcessed');
    expect(envelope.version).toBe(1);
    expect(envelope.aggregateId).toBe(transaction.id);
    expect(envelope.correlationId).toBe('correlation-id');
    expect(envelope.occurredAt).toBe('2026-10-14T10:01:00.000Z');
    expect(envelope.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(envelope.data.processedAt).toBe('2026-10-14T10:01:00.000Z');
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.data)).toBe(true);
  });

  it('creates a rejected event only from a rejected transaction', () => {
    const transaction = bet();
    transaction.reject(FailureCode.InsufficientFunds, context.occurredAt);

    const event = WagerTransactionRejected.from(transaction, context);

    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(event.eventType).toBe('WagerTransactionRejected');
  });

  it('creates a pending-reference event with the provider reference', () => {
    const transaction = WagerTransaction.create({
      id: 'refund-id',
      providerId: 'provider-a',
      externalTransactionId: 'refund-external-id',
      idempotencyKey: 'provider-a:refund-external-id',
      payloadHash: 'refund-hash',
      walletId: 'wallet-id',
      playerId: 'player-id',
      roundId: 'round-id',
      gameId: 'game-id',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-external-id',
      createdAt: new Date('2026-10-14T10:00:00.000Z'),
    });
    transaction.markPendingReference();

    const event = WagerTransactionPendingReference.from(transaction, context);

    expect(event.data.referenceExternalTransactionId).toBe('bet-external-id');
  });

  it('creates WalletBalanceChanged from a wallet and its balanced ledger entry', () => {
    const wallet = Wallet.open({
      id: 'wallet-id',
      playerId: 'player-id',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      createdAt: new Date('2026-10-14T10:00:00.000Z'),
    });
    const change = wallet.debit(
      Money.from({ amount: '25.00', currency: 'BRL' }),
      context.occurredAt,
    );
    const entry = WalletLedgerEntry.fromBalanceChange({
      id: 'entry-id',
      transactionId: 'transaction-id',
      change,
    });

    const event = WalletBalanceChanged.from(wallet, entry, context);

    expect(event.data.balanceBefore).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(event.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(event.data.walletVersion).toBe(2);
  });

  it('rejects events created from incompatible source state', () => {
    expect(() => WagerTransactionProcessed.from(bet(), context)).toThrow(InvalidEventSourceError);
  });

  it('protects its timestamp from external mutation', () => {
    const transaction = bet();
    transaction.markProcessed(undefined, context.occurredAt);
    const event = WagerTransactionProcessed.from(transaction, context);

    context.occurredAt.setUTCFullYear(2000);
    event.occurredAt.setUTCFullYear(2001);

    expect(event.occurredAt.toISOString()).toBe('2026-10-14T10:01:00.000Z');
  });
});
