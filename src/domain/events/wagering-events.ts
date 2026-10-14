import { IntegrationEvent, type EventContext } from './integration-event';
import type { MoneyProps } from '../shared/value-objects/money';
import type { FailureCode } from '../wagering/failure-code';
import {
  WagerTransactionStatus,
  type WagerTransaction,
  type WagerTransactionKind,
} from '../wagering/wager-transaction';

interface WagerTransactionEventData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Readonly<MoneyProps>;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  readonly referenceTransactionId?: string;
  readonly processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  readonly failureCode: FailureCode;
  readonly processedAt: string;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  readonly referenceExternalTransactionId: string;
}

export class InvalidEventSourceError extends Error {
  readonly code = 'INVALID_EVENT_SOURCE';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidEventSourceError';
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(transaction: WagerTransaction, context: EventContext) {
    const processedAt = transaction.processedAt;

    if (transaction.status !== WagerTransactionStatus.Processed || processedAt === undefined) {
      throw new InvalidEventSourceError('Processed event requires a processed transaction');
    }

    super({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        referenceTransactionId: transaction.referenceTransactionId,
        processedAt: processedAt.toISOString(),
      },
    });
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(transaction, context);
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(transaction: WagerTransaction, context: EventContext) {
    const processedAt = transaction.processedAt;
    const failureCode = transaction.failureCode;

    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      processedAt === undefined ||
      failureCode === undefined
    ) {
      throw new InvalidEventSourceError('Rejected event requires a rejected transaction');
    }

    super({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        failureCode,
        processedAt: processedAt.toISOString(),
      },
    });
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(transaction, context);
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(transaction: WagerTransaction, context: EventContext) {
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId;

    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      referenceExternalTransactionId === undefined
    ) {
      throw new InvalidEventSourceError(
        'Pending reference event requires a transaction waiting for a reference',
      );
    }

    super({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        referenceExternalTransactionId,
      },
    });
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(transaction, context);
  }
}

function transactionData(transaction: WagerTransaction): WagerTransactionEventData {
  return Object.freeze({
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  });
}
