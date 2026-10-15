import { describe, expect, test } from 'bun:test';

import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionCommand,
} from '../../../../src/application/wagering/process-wager-transaction.use-case';
import { WagerIdempotencyConflictError } from '../../../../src/application/wagering/process-wager-transaction.errors';
import type {
  WageringTransactionContext,
  WageringUnitOfWork,
} from '../../../../src/application/wagering/ports/wagering-unit-of-work';
import type { WalletLedgerEntry } from '../../../../src/domain/ledger/wallet-ledger-entry';
import type { OutboxMessage } from '../../../../src/domain/messaging/outbox-message';
import { Money } from '../../../../src/domain/shared/value-objects/money';
import { FailureCode } from '../../../../src/domain/wagering/failure-code';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../../../src/domain/wallet/wallet';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

class InMemoryWageringUnitOfWork implements WageringUnitOfWork {
  readonly transactions: WagerTransaction[] = [];
  readonly ledgerEntries: WalletLedgerEntry[] = [];
  readonly outboxMessages: OutboxMessage[] = [];
  walletUpdates = 0;

  constructor(readonly wallet: Wallet | undefined) {}

  execute<T>(work: (context: WageringTransactionContext) => Promise<T>): Promise<T> {
    return work({
      findTransactionByIdempotencyKey: (key) =>
        Promise.resolve(this.transactions.find((transaction) => transaction.idempotencyKey === key)),
      findTransactionByExternalId: (providerId, externalId) =>
        Promise.resolve(
          this.transactions.find(
            (transaction) =>
              transaction.providerId === providerId &&
              transaction.externalTransactionId === externalId,
          ),
        ),
      lockWallet: () => Promise.resolve(this.wallet),
      insertTransaction: (transaction) => {
        this.transactions.push(transaction);
        return Promise.resolve();
      },
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
});
