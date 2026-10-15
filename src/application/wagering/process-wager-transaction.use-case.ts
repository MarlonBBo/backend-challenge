import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { WalletBalanceChanged } from '../../domain/events/wallet-events';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/events/wagering-events';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/shared/value-objects/money';
import { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  InvalidWagerReferenceError,
} from '../../domain/wagering/wager-transaction';
import { InsufficientFundsError, type Wallet } from '../../domain/wallet/wallet';
import { sha256CanonicalJson } from '../shared/canonical-json';
import {
  MissingTransactionResultError,
  WagerIdempotencyConflictError,
  WagerWalletNotFoundError,
} from './process-wager-transaction.errors';
import {
  ConcurrentExternalTransactionError,
  ConcurrentIdempotencyError,
  ExternalTransactionAlreadyExistsError,
  WAGERING_UNIT_OF_WORK,
  type WageringTransactionContext,
  type WageringUnitOfWork,
} from './ports/wagering-unit-of-work';

export interface ProcessWagerTransactionCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly correlationId: string;
}

export interface ProcessWagerTransactionResult {
  readonly transactionId: string;
  readonly status:
    | WagerTransactionStatus.Processed
    | WagerTransactionStatus.Rejected
    | WagerTransactionStatus.PendingReference;
  readonly balance?: Readonly<MoneyProps>;
  readonly failureCode?: FailureCode;
  readonly idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(WAGERING_UNIT_OF_WORK)
    private readonly unitOfWork: WageringUnitOfWork,
  ) {}

  async execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<Readonly<ProcessWagerTransactionResult>> {
    const money = Money.from(command.money);
    const payloadHash = sha256CanonicalJson({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    try {
      return await this.executeOnce(command, money, payloadHash);
    } catch (error) {
      if (error instanceof ConcurrentIdempotencyError) {
        return this.executeOnce(command, money, payloadHash);
      }

      if (error instanceof ConcurrentExternalTransactionError) {
        throw new ExternalTransactionAlreadyExistsError(
          command.providerId,
          command.externalTransactionId,
        );
      }

      throw error;
    }
  }

  private executeOnce(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<Readonly<ProcessWagerTransactionResult>> {
    return this.unitOfWork.execute(async (context) => {
      const existing = await context.findTransactionByIdempotencyKey(command.idempotencyKey);
      if (existing !== undefined) {
        return this.replay(existing, payloadHash, command.idempotencyKey);
      }

      const externalTransaction = await context.findTransactionByExternalId(
        command.providerId,
        command.externalTransactionId,
      );
      if (externalTransaction !== undefined) {
        throw new ExternalTransactionAlreadyExistsError(
          command.providerId,
          command.externalTransactionId,
        );
      }

      const wallet = await context.lockWallet(command.walletId);
      if (wallet === undefined) {
        throw new WagerWalletNotFoundError(command.walletId);
      }

      const existingAfterLock = await context.findTransactionByIdempotencyKey(
        command.idempotencyKey,
      );
      if (existingAfterLock !== undefined) {
        return this.replay(existingAfterLock, payloadHash, command.idempotencyKey);
      }

      const externalAfterLock = await context.findTransactionByExternalId(
        command.providerId,
        command.externalTransactionId,
      );
      if (externalAfterLock !== undefined) {
        throw new ExternalTransactionAlreadyExistsError(
          command.providerId,
          command.externalTransactionId,
        );
      }

      return this.processNew(context, command, money, payloadHash, wallet);
    });
  }

  private async processNew(
    context: WageringTransactionContext,
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
    wallet: Wallet,
  ): Promise<Readonly<ProcessWagerTransactionResult>> {
    const now = new Date();
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    let ledgerEntry: WalletLedgerEntry | undefined;

    if (wallet.playerId !== command.playerId) {
      transaction.reject(FailureCode.WalletPlayerMismatch, now, wallet.balance);
    } else if (wallet.currency !== money.currency) {
      transaction.reject(FailureCode.CurrencyMismatch, now);
    } else if (command.kind === WagerTransactionKind.Loss) {
      transaction.markProcessed(undefined, now, wallet.balance);
    } else {
      const reference =
        command.referenceExternalTransactionId === undefined
          ? undefined
          : await context.findTransactionByExternalId(
              command.providerId,
              command.referenceExternalTransactionId,
            );

      if (command.referenceExternalTransactionId !== undefined && reference === undefined) {
        transaction.markPendingReference(wallet.balance, new Date(now.getTime() + 1_000));
      } else {
        ledgerEntry = await this.processBalanceMovement(
          context,
          transaction,
          reference,
          wallet,
          now,
        );
      }
    }

    const outboxMessages = this.createOutboxMessages(
      transaction,
      wallet,
      ledgerEntry,
      command.correlationId,
      now,
    );

    await context.insertTransaction(transaction);
    if (ledgerEntry !== undefined) {
      await context.updateWallet(wallet);
      await context.insertLedgerEntry(ledgerEntry);
    }
    await context.insertOutboxMessages(outboxMessages);

    return this.resultFrom(transaction, false);
  }

  private async processBalanceMovement(
    context: WageringTransactionContext,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    wallet: Wallet,
    now: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    try {
      const direction = transaction.ledgerDirectionFor(reference);

      if (
        reference !== undefined &&
        (transaction.kind === WagerTransactionKind.Refund ||
          transaction.kind === WagerTransactionKind.Rollback)
      ) {
        const existingReversal = await context.findProcessedReversal(
          reference.id,
          transaction.kind,
        );
        if (existingReversal !== undefined) {
          transaction.reject(
            transaction.kind === WagerTransactionKind.Refund
              ? FailureCode.ReferenceAlreadyRefunded
              : FailureCode.ReferenceAlreadyRolledBack,
            now,
            wallet.balance,
            reference,
          );
          return undefined;
        }
      }

      const change =
        direction === LedgerDirection.Credit
          ? wallet.credit(transaction.money, now)
          : wallet.debit(transaction.money, now);
      const ledgerEntry = WalletLedgerEntry.fromBalanceChange({
        id: randomUUID(),
        transactionId: transaction.id,
        change,
      });
      transaction.markProcessed(reference, now, wallet.balance);
      return ledgerEntry;
    } catch (error) {
      if (error instanceof InvalidWagerReferenceError) {
        transaction.reject(error.failureCode, now, wallet.balance, reference);
        return undefined;
      }

      if (error instanceof InsufficientFundsError) {
        transaction.reject(
          transaction.kind === WagerTransactionKind.Rollback
            ? FailureCode.ReversalWouldCauseNegativeBalance
            : FailureCode.InsufficientFunds,
          now,
          wallet.balance,
          reference,
        );
        return undefined;
      }

      throw error;
    }
  }

  private createOutboxMessages(
    transaction: WagerTransaction,
    wallet: Wallet,
    ledgerEntry: WalletLedgerEntry | undefined,
    correlationId: string,
    occurredAt: Date,
  ): readonly OutboxMessage[] {
    const context = {
      eventId: randomUUID(),
      correlationId,
      causationId: transaction.id,
      occurredAt,
    };
    const transactionEvent = (() => {
      switch (transaction.status) {
        case WagerTransactionStatus.Processed:
          return WagerTransactionProcessed.from(transaction, context);
        case WagerTransactionStatus.Rejected:
          return WagerTransactionRejected.from(transaction, context);
        case WagerTransactionStatus.PendingReference:
          return WagerTransactionPendingReference.from(transaction, context);
        case WagerTransactionStatus.Pending:
        case WagerTransactionStatus.Failed:
          throw new MissingTransactionResultError(transaction.id);
      }
    })();
    const messages = [OutboxMessage.enqueue(transactionEvent)];

    if (ledgerEntry !== undefined) {
      messages.push(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, ledgerEntry, {
            ...context,
            eventId: randomUUID(),
          }),
        ),
      );
    }

    return messages;
  }

  private replay(
    transaction: WagerTransaction,
    payloadHash: string,
    idempotencyKey: string,
  ): Readonly<ProcessWagerTransactionResult> {
    if (!transaction.matchesPayload(payloadHash)) {
      throw new WagerIdempotencyConflictError(idempotencyKey);
    }

    if (transaction.status === WagerTransactionStatus.Pending) {
      throw new MissingTransactionResultError(transaction.id);
    }

    return this.resultFrom(transaction, true);
  }

  private resultFrom(
    transaction: WagerTransaction,
    idempotentReplay: boolean,
  ): Readonly<ProcessWagerTransactionResult> {
    if (
      transaction.status !== WagerTransactionStatus.Processed &&
      transaction.status !== WagerTransactionStatus.Rejected &&
      transaction.status !== WagerTransactionStatus.PendingReference
    ) {
      throw new MissingTransactionResultError(transaction.id);
    }

    return Object.freeze({
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.resultBalance?.toJSON(),
      failureCode: transaction.failureCode,
      idempotentReplay,
    });
  }
}
