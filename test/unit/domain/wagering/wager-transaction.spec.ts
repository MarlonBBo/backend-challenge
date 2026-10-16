import { describe, expect, it } from 'bun:test';

import { LedgerDirection } from '../../../../src/domain/ledger/ledger-direction';
import { Money } from '../../../../src/domain/shared/value-objects/money';
import { FailureCode } from '../../../../src/domain/wagering/failure-code';
import {
  InvalidTransactionStateError,
  InvalidWagerReferenceError,
  InvalidWagerTransactionError,
  LedgerDirectionNotApplicableError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from '../../../../src/domain/wagering/wager-transaction';

const createdAt = new Date('2026-10-14T10:00:00.000Z');
const processedAt = new Date('2026-10-14T10:00:01.000Z');

function brl(amount = '25.00'): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function props(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  const referenceExternalTransactionId =
    kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
      ? 'bet-external-id'
      : undefined;

  return {
    id: `${kind.toLowerCase()}-internal-id`,
    providerId: 'provider-a',
    externalTransactionId: `${kind.toLowerCase()}-external-id`,
    idempotencyKey: `provider-a:${kind.toLowerCase()}-external-id`,
    payloadHash: `${kind.toLowerCase()}-payload-hash`,
    walletId: 'wallet-id',
    playerId: 'player-id',
    roundId: 'round-id',
    gameId: 'game-id',
    kind,
    money: brl(),
    referenceExternalTransactionId,
    createdAt,
    ...overrides,
  };
}

function create(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create(props(kind, overrides));
}

describe('Reference retry state', () => {
  it('counts attempts only for pending references and protects retry timestamps', () => {
    const transaction = create(WagerTransactionKind.Refund);
    expect(() => transaction.recordReferenceAttempt()).toThrow(InvalidWagerTransactionError);
    const nextAttempt = new Date(processedAt);
    transaction.markPendingReference(brl('100.00'), nextAttempt);
    transaction.recordReferenceAttempt();
    nextAttempt.setTime(0);
    expect(transaction.referenceAttempts).toBe(1);
    expect(transaction.nextReferenceAttemptAt?.getTime()).toBe(processedAt.getTime());
    transaction.nextReferenceAttemptAt?.setTime(0);
    expect(transaction.nextReferenceAttemptAt?.getTime()).toBe(processedAt.getTime());
    transaction.reject(FailureCode.ReferenceNotFound, processedAt, brl('100.00'));
    expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    expect(() => transaction.recordReferenceAttempt()).toThrow(InvalidTransactionStateError);
  });

  it('does not mutate a terminal result when another rejection is attempted', () => {
    const transaction = create(WagerTransactionKind.Bet);
    transaction.markProcessed(undefined, processedAt, brl('75.00'));
    expect(() =>
      transaction.reject(FailureCode.ReferenceNotFound, processedAt, brl('0.00')),
    ).toThrow(InvalidTransactionStateError);
    expect(transaction.resultBalance?.toJSON().amount).toBe('75.00');
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  });
});

function processed(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const transaction = create(kind, overrides);
  transaction.markProcessed(undefined, processedAt);
  return transaction;
}

describe('WagerTransaction', () => {
  describe('create', () => {
    it.each([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ])('creates %s in PENDING status', (kind) => {
      const transaction = create(kind);

      expect(transaction.kind).toBe(kind);
      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(transaction.isTerminal()).toBe(false);
      expect(transaction.failureCode).toBeUndefined();
      expect(transaction.processedAt).toBeUndefined();
    });

    it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
      'requires an external reference for %s',
      (kind) => {
        expect(() => create(kind, { referenceExternalTransactionId: undefined })).toThrow(
          InvalidWagerTransactionError,
        );
      },
    );

    it.each([WagerTransactionKind.Bet, WagerTransactionKind.Loss])(
      'does not allow an external reference for %s',
      (kind) => {
        expect(() => create(kind, { referenceExternalTransactionId: 'unexpected' })).toThrow(
          InvalidWagerTransactionError,
        );
      },
    );

    it('allows WIN to declare an optional BET reference', () => {
      const transaction = create(WagerTransactionKind.Win, {
        referenceExternalTransactionId: 'bet-external-id',
      });

      expect(transaction.referenceExternalTransactionId).toBe('bet-external-id');
    });

    it.each(['', ' bet-external-id', 'bet-external-id '])(
      'rejects the non-canonical external reference %p',
      (referenceExternalTransactionId) => {
        expect(() => create(WagerTransactionKind.Win, { referenceExternalTransactionId })).toThrow(
          InvalidWagerTransactionError,
        );
      },
    );

    it.each([Money.zero('BRL'), brl('1.00').negate()])(
      'rejects a non-positive transaction amount',
      (money) => {
        expect(() => create(WagerTransactionKind.Bet, { money })).toThrow(
          InvalidWagerTransactionError,
        );
      },
    );

    it('does not allow external creation of OPENING', () => {
      expect(() => WagerTransaction.create(props(WagerTransactionKind.Opening))).toThrow(
        InvalidWagerTransactionError,
      );
    });

    it('creates OPENING through its internal factory', () => {
      const transaction = WagerTransaction.createOpening({
        id: 'opening-id',
        payloadHash: 'opening-hash',
        walletId: 'wallet-id',
        playerId: 'player-id',
        money: brl('100.00'),
        createdAt,
      });

      expect(transaction.kind).toBe(WagerTransactionKind.Opening);
      expect(transaction.providerId).toBe('system');
      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(transaction.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });
  });

  describe('state transitions', () => {
    it('marks a transaction as processed', () => {
      const transaction = create(WagerTransactionKind.Bet);

      transaction.markProcessed(undefined, processedAt);

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.processedAt).toEqual(processedAt);
      expect(transaction.isTerminal()).toBe(true);
    });

    it('moves a referenced transaction through PENDING_REFERENCE to PROCESSED', () => {
      const bet = processed(WagerTransactionKind.Bet, {
        externalTransactionId: 'bet-external-id',
      });
      const refund = create(WagerTransactionKind.Refund);

      refund.markPendingReference();
      expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

      refund.markProcessed(bet, processedAt);
      expect(refund.status).toBe(WagerTransactionStatus.Processed);
      expect(refund.referenceTransactionId).toBe(bet.id);
    });

    it('rejects a transaction with a stable failure code', () => {
      const transaction = create(WagerTransactionKind.Bet);

      transaction.reject(FailureCode.InsufficientFunds, processedAt);

      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(transaction.processedAt).toEqual(processedAt);
    });

    it('marks a permanent infrastructure failure', () => {
      const transaction = create(WagerTransactionKind.Bet);

      transaction.fail(FailureCode.PermanentInfrastructureFailure, processedAt);

      expect(transaction.status).toBe(WagerTransactionStatus.Failed);
      expect(transaction.failureCode).toBe(FailureCode.PermanentInfrastructureFailure);
    });

    it.each([
      (transaction: WagerTransaction) => transaction.markProcessed(undefined, processedAt),
      (transaction: WagerTransaction) => transaction.markPendingReference(),
      (transaction: WagerTransaction) =>
        transaction.reject(FailureCode.InvalidPayload, processedAt),
      (transaction: WagerTransaction) =>
        transaction.fail(FailureCode.PermanentInfrastructureFailure, processedAt),
    ])('prevents every transition from a terminal state', (transition) => {
      const transaction = processed(WagerTransactionKind.Bet);

      expect(() => transition(transaction)).toThrow(InvalidTransactionStateError);
    });

    it('does not allow a transaction without a reference to wait for one', () => {
      const transaction = create(WagerTransactionKind.Bet);

      expect(() => transaction.markPendingReference()).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('domain queries', () => {
    it.each([
      [WagerTransactionKind.Opening, true],
      [WagerTransactionKind.Bet, true],
      [WagerTransactionKind.Win, true],
      [WagerTransactionKind.Loss, false],
      [WagerTransactionKind.Refund, true],
      [WagerTransactionKind.Rollback, true],
    ])('reports whether %s affects the balance', (kind, expected) => {
      const transaction =
        kind === WagerTransactionKind.Opening
          ? WagerTransaction.createOpening({
              id: 'opening-id',
              payloadHash: 'hash',
              walletId: 'wallet-id',
              playerId: 'player-id',
              money: brl(),
              createdAt,
            })
          : create(kind);

      expect(transaction.affectsBalance()).toBe(expected);
    });

    it('matches an identical payload hash and rejects a different one', () => {
      const transaction = create(WagerTransactionKind.Bet);

      expect(transaction.matchesPayload('bet-payload-hash')).toBe(true);
      expect(transaction.matchesPayload('different-hash')).toBe(false);
    });
  });

  describe('ledger direction and references', () => {
    it('maps direct operations to their ledger direction', () => {
      expect(create(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(create(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });

    it('does not provide a ledger direction for LOSS', () => {
      expect(() => create(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(
        LedgerDirectionNotApplicableError,
      );
    });

    it('maps REFUND of BET to CREDIT', () => {
      const bet = processed(WagerTransactionKind.Bet, {
        externalTransactionId: 'bet-external-id',
      });
      const refund = create(WagerTransactionKind.Refund);

      expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    });

    it.each([
      [WagerTransactionKind.Bet, LedgerDirection.Credit],
      [WagerTransactionKind.Win, LedgerDirection.Debit],
      [WagerTransactionKind.Refund, LedgerDirection.Debit],
    ])('inverts %s when calculating ROLLBACK direction', (referenceKind, expected) => {
      const reference =
        referenceKind === WagerTransactionKind.Refund
          ? (() => {
              const originalBet = processed(WagerTransactionKind.Bet, {
                externalTransactionId: 'original-bet-id',
              });
              const refund = create(WagerTransactionKind.Refund, {
                externalTransactionId: 'bet-external-id',
                referenceExternalTransactionId: 'original-bet-id',
              });
              refund.markProcessed(originalBet, processedAt);
              return refund;
            })()
          : processed(referenceKind, {
              externalTransactionId: 'bet-external-id',
            });
      const rollback = create(WagerTransactionKind.Rollback);

      expect(rollback.ledgerDirectionFor(reference)).toBe(expected);
    });

    it('requires a resolved reference for a dependent transaction', () => {
      const refund = create(WagerTransactionKind.Refund);

      expect(() => refund.ledgerDirectionFor()).toThrow(InvalidWagerReferenceError);
    });

    it.each([
      { providerId: 'provider-b' },
      { playerId: 'another-player' },
      { walletId: 'another-wallet' },
      { roundId: 'another-round' },
      { money: Money.from({ amount: '25.00', currency: 'USD' }) },
    ])('rejects a reference from a different context', (override) => {
      const reference = processed(WagerTransactionKind.Bet, {
        externalTransactionId: 'bet-external-id',
        ...override,
      });
      const refund = create(WagerTransactionKind.Refund);

      expect(() => refund.ledgerDirectionFor(reference)).toThrow(InvalidWagerReferenceError);
    });

    it('allows a WIN amount different from its referenced BET', () => {
      const reference = processed(WagerTransactionKind.Bet);
      const win = create(WagerTransactionKind.Win, {
        referenceExternalTransactionId: reference.externalTransactionId,
        money: brl('100.00'),
      });
      expect(win.ledgerDirectionFor(reference)).toBe(LedgerDirection.Credit);
      win.markProcessed(reference, processedAt);
      expect(win.status).toBe(WagerTransactionStatus.Processed);
    });

    it('rejects a different reference amount', () => {
      const reference = processed(WagerTransactionKind.Bet, {
        externalTransactionId: 'bet-external-id',
        money: brl('30.00'),
      });
      const refund = create(WagerTransactionKind.Refund);

      try {
        refund.ledgerDirectionFor(reference);
        throw new Error('Expected reference validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidWagerReferenceError);
        expect((error as InvalidWagerReferenceError).failureCode).toBe(
          FailureCode.ReferenceAmountMismatch,
        );
      }
    });

    it('rejects an invalid reference kind', () => {
      const win = processed(WagerTransactionKind.Win, {
        externalTransactionId: 'bet-external-id',
      });
      const refund = create(WagerTransactionKind.Refund);

      expect(() => refund.ledgerDirectionFor(win)).toThrow(InvalidWagerReferenceError);
    });
  });

  describe('rehydration and date encapsulation', () => {
    it('rehydrates terminal persisted state without replaying transitions', () => {
      const transaction = WagerTransaction.rehydrate({
        ...props(WagerTransactionKind.Bet),
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.InsufficientFunds,
        processedAt,
      });

      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(transaction.processedAt).toEqual(processedAt);
    });

    it('does not expose mutable internal timestamps', () => {
      const suppliedCreatedAt = new Date(createdAt);
      const transaction = create(WagerTransactionKind.Bet, {
        createdAt: suppliedCreatedAt,
      });
      transaction.markProcessed(undefined, processedAt);

      suppliedCreatedAt.setUTCFullYear(2000);
      transaction.createdAt.setUTCFullYear(2001);
      transaction.processedAt?.setUTCFullYear(2002);

      expect(transaction.createdAt).toEqual(createdAt);
      expect(transaction.processedAt).toEqual(processedAt);
    });
  });
});
