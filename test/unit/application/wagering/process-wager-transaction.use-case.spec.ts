import { describe, expect, test } from 'bun:test';

import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionCommand,
} from '../../../../src/application/wagering/process-wager-transaction.use-case';
import { WagerIdempotencyConflictError } from '../../../../src/application/wagering/process-wager-transaction.errors';
import { ReferenceRetryPolicy } from '../../../../src/application/wagering/reference-retry-policy';
import type {
  WageringTransactionContext,
  WageringUnitOfWork,
} from '../../../../src/application/wagering/ports/wagering-unit-of-work';
import type { WalletLedgerEntry } from '../../../../src/domain/ledger/wallet-ledger-entry';
import { LedgerDirection } from '../../../../src/domain/ledger/ledger-direction';
import type { OutboxMessage } from '../../../../src/domain/messaging/outbox-message';
import { Money } from '../../../../src/domain/shared/value-objects/money';
import { FailureCode } from '../../../../src/domain/wagering/failure-code';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../../../src/domain/wallet/wallet';
import { InboxMessage } from '../../../../src/domain/messaging/inbox-message';
import { InboxPayloadConflictError } from '../../../../src/application/wagering/ports/inbox-delivery';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

class InMemoryWageringUnitOfWork implements WageringUnitOfWork {
  readonly transactions: WagerTransaction[] = [];
  readonly inbox: InboxMessage[] = [];
  readonly ledgerEntries: WalletLedgerEntry[] = [];
  readonly outboxMessages: OutboxMessage[] = [];
  walletUpdates = 0;

  constructor(readonly wallet: Wallet | undefined) {}

  executeNextPending<T>(
    now: Date,
    work: (
      context: WageringTransactionContext,
      transaction: WagerTransaction,
      wallet: Wallet,
    ) => Promise<T>,
  ): Promise<T | undefined> {
    const pending = this.transactions.find(
      (transaction) =>
        transaction.status === WagerTransactionStatus.PendingReference &&
        (transaction.nextReferenceAttemptAt === undefined ||
          transaction.nextReferenceAttemptAt <= now),
    );
    if (pending === undefined || this.wallet === undefined) return Promise.resolve(undefined);
    const wallet = this.wallet;
    return this.execute((context) => work(context, pending, wallet));
  }

  execute<T>(work: (context: WageringTransactionContext) => Promise<T>): Promise<T> {
    return work({
      findCorrelationId: (id) => {
        const value = this.outboxMessages.find(
          (message) =>
            message.aggregateId === id && message.eventType === 'WagerTransactionPendingReference',
        )?.payload.correlationId;
        return Promise.resolve(typeof value === 'string' ? value : undefined);
      },
      receiveInbox: (delivery) => {
        let message = this.inbox.find(
          (entry) =>
            entry.messageId === delivery.messageId && entry.consumerName === delivery.consumerName,
        );
        if (message === undefined) {
          message = InboxMessage.receive({ ...delivery, receivedAt: new Date() });
          this.inbox.push(message);
        }
        return Promise.resolve(message);
      },
      completeInbox: () => Promise.resolve(),
      findTransactionByIdempotencyKey: (key) =>
        Promise.resolve(
          this.transactions.find((transaction) => transaction.idempotencyKey === key),
        ),
      findTransactionByExternalId: (providerId, externalId) =>
        Promise.resolve(
          this.transactions.find(
            (transaction) =>
              transaction.providerId === providerId &&
              transaction.externalTransactionId === externalId,
          ),
        ),
      findProcessedReversal: (referenceTransactionId, kind) =>
        Promise.resolve(
          this.transactions.find(
            (transaction) =>
              transaction.referenceTransactionId === referenceTransactionId &&
              transaction.kind === kind &&
              transaction.status === WagerTransactionStatus.Processed,
          ),
        ),
      lockWallet: () => Promise.resolve(this.wallet),
      insertTransaction: (transaction) => {
        this.transactions.push(transaction);
        return Promise.resolve();
      },
      updateTransaction: () => Promise.resolve(),
      updateWallet: () => {
        this.walletUpdates += 1;
        return Promise.resolve();
      },
      insertLedgerEntry: (entry) => {
        this.ledgerEntries.push(entry);
        return Promise.resolve();
      },
      insertOutboxMessages: (messages) => {
        this.outboxMessages.push(...messages);
        return Promise.resolve();
      },
    });
  }
}

function openWallet(balance = '100.00'): Wallet {
  return Wallet.open({
    id: walletId,
    playerId,
    initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
    createdAt: new Date('2026-10-14T12:00:00.000Z'),
  });
}

function command(
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-1',
    idempotencyKey: 'provider-a:transaction-1',
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: 'correlation-1',
    ...overrides,
  };
}

describe('ProcessWagerTransactionUseCase', () => {
  test('replays when another process commits between the key and external identity reads', async () => {
    const memory = new InMemoryWageringUnitOfWork(openWallet());
    await new ProcessWagerTransactionUseCase(memory).execute(command());
    const racing: WageringUnitOfWork = {
      executeNextPending: (now, work) => memory.executeNextPending(now, work),
      execute: (work) =>
        memory.execute((context) =>
          work({
            ...context,
            findTransactionByIdempotencyKey: () => Promise.resolve(undefined),
          }),
        ),
    };
    const replay = await new ProcessWagerTransactionUseCase(racing).execute(command());
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance?.amount).toBe('75.00');
    expect(memory.ledgerEntries).toHaveLength(1);
    expect(
      new ProcessWagerTransactionUseCase(racing).execute(
        command({
          money: { amount: '26.00', currency: 'BRL' },
        }),
      ),
    ).rejects.toBeInstanceOf(WagerIdempotencyConflictError);
  });
  test('records a processed inbox and replays redelivery without financial effects', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    const delivery = { consumerName: 'consumer', messageId: 'message', payloadHash: 'hash' };
    await useCase.execute(command(), delivery);
    const replay = await useCase.execute(command(), delivery);
    expect(replay.idempotentReplay).toBe(true);
    expect(unitOfWork.inbox).toHaveLength(1);
    expect(unitOfWork.inbox[0]?.isProcessed()).toBe(true);
    expect(unitOfWork.ledgerEntries).toHaveLength(1);
    expect(
      useCase.execute(command(), { ...delivery, payloadHash: 'different' }),
    ).rejects.toBeInstanceOf(InboxPayloadConflictError);
  });
  function pendingCommand(): ProcessWagerTransactionCommand {
    return command({
      externalTransactionId: 'refund-before-bet',
      idempotencyKey: 'pending-refund',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'transaction-1',
    });
  }

  test('retries REFUND after BET arrives and replays its final result without another ledger', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    const pending = await useCase.execute(pendingCommand());
    const due = unitOfWork.transactions[0]!.nextReferenceAttemptAt!;
    await useCase.execute(command());

    const processed = await useCase.reprocessNextPending(due);
    expect(processed?.transactionId).toBe(pending.transactionId);
    expect(processed?.status).toBe(WagerTransactionStatus.Processed);
    expect(processed?.balance?.amount).toBe('100.00');
    expect(unitOfWork.transactions[0]?.referenceAttempts).toBe(1);
    expect(unitOfWork.transactions[0]?.nextReferenceAttemptAt).toBeUndefined();
    expect(await useCase.reprocessNextPending(due)).toBeUndefined();
    expect((await useCase.execute(pendingCommand())).idempotentReplay).toBe(true);
    expect(unitOfWork.ledgerEntries).toHaveLength(2);
    expect(
      unitOfWork.outboxMessages
        .filter((message) => message.aggregateId === pending.transactionId)
        .map((message) => message.eventType),
    ).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed']);
  });

  test('does not attempt pending references before their due date', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    await useCase.execute(pendingCommand());
    expect(await useCase.reprocessNextPending(new Date(0))).toBeUndefined();
    expect(unitOfWork.transactions[0]?.referenceAttempts).toBe(0);
  });

  test('backs off a missing reference without repeating pending events or moving money', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    await useCase.execute(pendingCommand());
    const firstDue = unitOfWork.transactions[0]!.nextReferenceAttemptAt!;
    const result = await useCase.reprocessNextPending(firstDue);
    expect(result?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(unitOfWork.transactions[0]?.referenceAttempts).toBe(1);
    expect(unitOfWork.transactions[0]?.nextReferenceAttemptAt?.getTime()).toBe(
      firstDue.getTime() + 2_000,
    );
    expect(unitOfWork.ledgerEntries).toHaveLength(0);
    expect(unitOfWork.walletUpdates).toBe(0);
    expect(unitOfWork.outboxMessages).toHaveLength(1);
  });

  test('rejects at the last allowed attempt with a terminal outbox event', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(
      unitOfWork,
      new ReferenceRetryPolicy({
        maxAttempts: 1,
        ttlMs: 86_400_000,
        baseDelayMs: 1_000,
        maxDelayMs: 300_000,
      }),
    );
    await useCase.execute(pendingCommand());
    const result = await useCase.reprocessNextPending(
      unitOfWork.transactions[0]!.nextReferenceAttemptAt,
    );
    expect(result?.status).toBe(WagerTransactionStatus.Rejected);
    expect(result?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(unitOfWork.transactions[0]?.referenceAttempts).toBe(1);
    expect(unitOfWork.transactions[0]?.nextReferenceAttemptAt).toBeUndefined();
    expect(unitOfWork.outboxMessages.map((message) => message.eventType)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(unitOfWork.ledgerEntries).toHaveLength(0);
    expect(await useCase.reprocessNextPending(new Date(Date.now() + 5_000))).toBeUndefined();
  });

  test('expires at the TTL without attempting or applying a reference that arrived too late', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    await useCase.execute(pendingCommand());
    await useCase.execute(command());
    const result = await useCase.reprocessNextPending(
      new Date(unitOfWork.transactions[0]!.createdAt.getTime() + 86_400_000),
    );
    expect(result?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(unitOfWork.transactions[0]?.referenceAttempts).toBe(0);
    expect(unitOfWork.wallet?.balance.toJSON().amount).toBe('75.00');
    expect(unitOfWork.ledgerEntries).toHaveLength(1);
  });

  test('rejects a pending duplicate REFUND when another refund processed first', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    await useCase.execute(pendingCommand());
    await useCase.execute(command());
    await useCase.execute({
      ...pendingCommand(),
      externalTransactionId: 'other-refund',
      idempotencyKey: 'other-refund',
    });
    const result = await useCase.reprocessNextPending(
      unitOfWork.transactions[0]!.nextReferenceAttemptAt,
    );
    expect(result?.failureCode).toBe(FailureCode.ReferenceAlreadyRefunded);
    expect(unitOfWork.ledgerEntries).toHaveLength(2);
    expect(unitOfWork.wallet?.balance.toJSON().amount).toBe('100.00');
  });

  test('retries ROLLBACK before its WIN reference and rejects a resulting negative balance', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet('0.00'));
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    await useCase.execute({ ...pendingCommand(), kind: WagerTransactionKind.Rollback });
    await useCase.execute(command({ kind: WagerTransactionKind.Win }));
    await useCase.execute(command({ externalTransactionId: 'spend', idempotencyKey: 'spend' }));
    const result = await useCase.reprocessNextPending(
      unitOfWork.transactions[0]!.nextReferenceAttemptAt,
    );
    expect(result?.failureCode).toBe(FailureCode.ReversalWouldCauseNegativeBalance);
    expect(unitOfWork.ledgerEntries).toHaveLength(2);
    expect(unitOfWork.wallet?.balance.toJSON().amount).toBe('0.00');
  });

  test('processes BET with wallet update, ledger and two outbox messages', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);

    const result = await useCase.execute(command());

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(result.idempotentReplay).toBe(false);
    expect(unitOfWork.wallet?.balance.toJSON().amount).toBe('75.00');
    expect(unitOfWork.walletUpdates).toBe(1);
    expect(unitOfWork.ledgerEntries).toHaveLength(1);
    expect(unitOfWork.outboxMessages.map((message) => message.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('processes LOSS without changing wallet or creating ledger', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);

    const result = await useCase.execute(
      command({ kind: WagerTransactionKind.Loss, money: { amount: '25.00', currency: 'BRL' } }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(unitOfWork.walletUpdates).toBe(0);
    expect(unitOfWork.ledgerEntries).toHaveLength(0);
    expect(unitOfWork.outboxMessages.map((message) => message.eventType)).toEqual([
      'WagerTransactionProcessed',
    ]);
  });

  test('rejects BET with insufficient funds without changing wallet or ledger', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet('20.00'));
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);

    const result = await useCase.execute(command());

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(unitOfWork.walletUpdates).toBe(0);
    expect(unitOfWork.ledgerEntries).toHaveLength(0);
    expect(unitOfWork.outboxMessages.map((message) => message.eventType)).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  test('replays the original result without duplicating financial effects', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);

    const first = await useCase.execute(command());
    const replay = await useCase.execute(command());

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(unitOfWork.transactions).toHaveLength(1);
    expect(unitOfWork.ledgerEntries).toHaveLength(1);
    expect(unitOfWork.walletUpdates).toBe(1);
    expect(unitOfWork.wallet?.balance.toJSON().amount).toBe('75.00');
  });

  test('rejects reuse of an idempotency key with a different payload', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    await useCase.execute(command());

    expect(
      useCase.execute(
        command({
          externalTransactionId: 'transaction-2',
          money: { amount: '30.00', currency: 'BRL' },
        }),
      ),
    ).rejects.toBeInstanceOf(WagerIdempotencyConflictError);
    expect(unitOfWork.transactions).toHaveLength(1);
    expect(unitOfWork.ledgerEntries).toHaveLength(1);
  });

  test('processes WIN with an optional BET reference and credits the wallet', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    await useCase.execute(command());

    const result = await useCase.execute(
      command({
        externalTransactionId: 'win-1',
        idempotencyKey: 'provider-a:win-1',
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'transaction-1',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(unitOfWork.ledgerEntries).toHaveLength(2);
    expect(unitOfWork.ledgerEntries[1]?.direction).toBe(LedgerDirection.Credit);
  });

  test('processes REFUND once and rejects a duplicate refund', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    await useCase.execute(command());

    const refund = await useCase.execute(
      command({
        externalTransactionId: 'refund-1',
        idempotencyKey: 'provider-a:refund-1',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-1',
      }),
    );
    const duplicate = await useCase.execute(
      command({
        externalTransactionId: 'refund-2',
        idempotencyKey: 'provider-a:refund-2',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-1',
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(duplicate.status).toBe(WagerTransactionStatus.Rejected);
    expect(duplicate.failureCode).toBe(FailureCode.ReferenceAlreadyRefunded);
    expect(unitOfWork.ledgerEntries).toHaveLength(2);
  });

  test('processes ROLLBACK of BET as a credit', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    await useCase.execute(command());

    const rollback = await useCase.execute(
      command({
        externalTransactionId: 'rollback-1',
        idempotencyKey: 'provider-a:rollback-1',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'transaction-1',
      }),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(unitOfWork.ledgerEntries[1]?.direction).toBe(LedgerDirection.Credit);
  });

  test('rejects ROLLBACK of WIN when its debit would make the balance negative', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet('10.00'));
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);
    await useCase.execute(
      command({
        externalTransactionId: 'win-1',
        idempotencyKey: 'provider-a:win-1',
        kind: WagerTransactionKind.Win,
        money: { amount: '50.00', currency: 'BRL' },
      }),
    );
    await useCase.execute(
      command({
        externalTransactionId: 'bet-after-win',
        idempotencyKey: 'provider-a:bet-after-win',
        money: { amount: '60.00', currency: 'BRL' },
      }),
    );

    const rollback = await useCase.execute(
      command({
        externalTransactionId: 'rollback-win-1',
        idempotencyKey: 'provider-a:rollback-win-1',
        kind: WagerTransactionKind.Rollback,
        money: { amount: '50.00', currency: 'BRL' },
        referenceExternalTransactionId: 'win-1',
      }),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldCauseNegativeBalance);
    expect(rollback.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(unitOfWork.wallet?.balance.toJSON().amount).toBe('0.00');
  });

  test('persists a missing reference as PENDING_REFERENCE without ledger', async () => {
    const unitOfWork = new InMemoryWageringUnitOfWork(openWallet());
    const useCase = new ProcessWagerTransactionUseCase(unitOfWork);

    const result = await useCase.execute(
      command({
        externalTransactionId: 'refund-before-bet',
        idempotencyKey: 'provider-a:refund-before-bet',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'future-bet',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(unitOfWork.ledgerEntries).toHaveLength(0);
    expect(unitOfWork.walletUpdates).toBe(0);
    expect(unitOfWork.transactions[0]?.nextReferenceAttemptAt).toBeDefined();
    expect(unitOfWork.outboxMessages.map((message) => message.eventType)).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });
});
