import { describe, expect, test } from 'bun:test';

import { CreateWalletUseCase } from '../../../../src/application/wallet/create-wallet.use-case';
import type {
  CreateWalletPersistenceBundle,
  CreateWalletUnitOfWork,
} from '../../../../src/application/wallet/ports/create-wallet-unit-of-work';
import { LedgerDirection } from '../../../../src/domain/ledger/ledger-direction';
import { WagerTransactionKind } from '../../../../src/domain/wagering/wager-transaction';

class RecordingCreateWalletUnitOfWork implements CreateWalletUnitOfWork {
  bundle?: CreateWalletPersistenceBundle;

  create(bundle: CreateWalletPersistenceBundle): Promise<void> {
    this.bundle = bundle;
    return Promise.resolve();
  }
}

describe('CreateWalletUseCase', () => {
  test('persists wallet, OPENING, ledger and outbox as one bundle', async () => {
    const unitOfWork = new RecordingCreateWalletUnitOfWork();
    const useCase = new CreateWalletUseCase(unitOfWork);

    const result = await useCase.execute({
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'correlation-1',
    });

    const bundle = unitOfWork.bundle;
    expect(bundle).toBeDefined();
    if (bundle === undefined) {
      throw new Error('Expected the persistence bundle to be recorded');
    }

    expect(result).toEqual({
      id: bundle.wallet.id,
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      balance: { amount: '100.00', currency: 'BRL' },
      version: 1,
    });
    expect(bundle.openingTransaction?.kind).toBe(WagerTransactionKind.Opening);
    expect(bundle.openingTransaction?.isTerminal()).toBe(true);
    expect(bundle.openingLedgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(bundle.openingLedgerEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(bundle.openingLedgerEntry?.balanceAfter.toJSON().amount).toBe('100.00');
    expect(bundle.outboxMessages.map((message) => message.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(
      bundle.outboxMessages.every((message) => message.payload.correlationId === 'correlation-1'),
    ).toBe(true);
  });

  test('persists only the wallet when the initial balance is zero', async () => {
    const unitOfWork = new RecordingCreateWalletUnitOfWork();
    const useCase = new CreateWalletUseCase(unitOfWork);

    const result = await useCase.execute({
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2',
      initialBalance: { amount: '0.00', currency: 'BRL' },
      correlationId: 'correlation-2',
    });

    expect(result.balance.amount).toBe('0.00');
    expect(unitOfWork.bundle?.openingTransaction).toBeUndefined();
    expect(unitOfWork.bundle?.openingLedgerEntry).toBeUndefined();
    expect(unitOfWork.bundle?.outboxMessages).toEqual([]);
  });
});
