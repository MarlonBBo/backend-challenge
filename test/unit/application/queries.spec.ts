import { describe, expect, mock, test } from 'bun:test';
import { GetWalletUseCase } from '../../../src/application/wallet/get-wallet.use-case';
import { GetWagerTransactionUseCase } from '../../../src/application/wagering/get-wager-transaction.use-case';
import { ResourceNotFoundError } from '../../../src/application/shared/resource-not-found.error';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { Money } from '../../../src/domain/shared/value-objects/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction';

const now = new Date('2026-10-15T12:00:00Z');

describe('Read use cases', () => {
  test('wallet query returns money as decimal strings and timestamps as ISO strings', async () => {
    const wallet = Wallet.open({
      id: 'wallet',
      playerId: 'player',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      createdAt: now,
    });
    const result = await new GetWalletUseCase({ findById: () => Promise.resolve(wallet) }).execute(
      wallet.id,
    );
    expect(result).toEqual({
      id: 'wallet',
      playerId: 'player',
      balance: { amount: '100.00', currency: 'BRL' },
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('missing wallet produces a stable not-found error', () => {
    expect(
      new GetWalletUseCase({ findById: () => Promise.resolve(undefined) }).execute('missing'),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  test('transaction query represents pending references without leaking persistence metadata', async () => {
    const transaction = WagerTransaction.rehydrate({
      id: 'tx',
      providerId: 'provider',
      externalTransactionId: 'refund',
      idempotencyKey: 'secret-key',
      payloadHash: 'hash',
      walletId: 'wallet',
      playerId: 'player',
      roundId: 'round',
      gameId: 'game',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      createdAt: now,
      status: WagerTransactionStatus.PendingReference,
      resultBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'missing-bet',
      referenceAttempts: 3,
      nextReferenceAttemptAt: new Date(now.getTime() + 8_000),
    });
    const reader = {
      findById: mock(() => Promise.resolve(transaction)),
      findByExternalId: mock(() => Promise.resolve(transaction)),
    };
    const result = await new GetWagerTransactionUseCase(reader).execute({
      providerId: 'provider',
      externalTransactionId: 'refund',
    });
    expect(reader.findByExternalId).toHaveBeenCalledWith('provider', 'refund');
    expect(reader.findById).not.toHaveBeenCalled();
    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(result.balance?.amount).toBe('100.00');
    expect(result.referenceAttempts).toBe(3);
    expect(result.nextReferenceAttemptAt).toBe('2026-10-15T12:00:08.000Z');
    expect(result.processedAt).toBeNull();
    expect(result.failureCode).toBeNull();
    expect(result).not.toHaveProperty('payloadHash');
    expect(result).not.toHaveProperty('idempotencyKey');
  });

  test('missing internal or provider-scoped transaction is not found', async () => {
    const query = new GetWagerTransactionUseCase({
      findById: () => Promise.resolve(undefined),
      findByExternalId: () => Promise.resolve(undefined),
    });
    expect(query.execute({ transactionId: 'missing' })).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    expect(
      query.execute({ providerId: 'provider', externalTransactionId: 'missing' }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    await Bun.sleep(1);
  });
});
