import { randomUUID } from 'node:crypto';
import { describe, expect, mock, test } from 'bun:test';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  InvalidLedgerCursorError,
} from '../../../src/application/wallet/ledger-cursor';
import {
  GetWalletLedgerUseCase,
  InvalidLedgerPaginationError,
} from '../../../src/application/wallet/get-wallet-ledger.use-case';
import { ResourceNotFoundError } from '../../../src/application/shared/resource-not-found.error';
import type { LedgerEntryView } from '../../../src/application/wallet/ports/wallet-ledger-reader';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { Money } from '../../../src/domain/shared/value-objects/money';

const walletId = randomUUID();
const position = { id: randomUUID(), createdAt: '2026-10-15T12:00:00.123456Z' };
const row: LedgerEntryView = {
  ...position,
  transactionId: randomUUID(),
  direction: LedgerDirection.Credit,
  money: { amount: '1.00', currency: 'BRL' },
  balanceBefore: { amount: '0.00', currency: 'BRL' },
  balanceAfter: { amount: '1.00', currency: 'BRL' },
};
const wallet = Wallet.open({
  id: walletId,
  playerId: randomUUID(),
  initialBalance: Money.zero('BRL'),
  createdAt: new Date(),
});

describe('Ledger cursor and page', () => {
  test('round-trips microseconds and accepts UUID casing for the same wallet', () => {
    const cursor = encodeLedgerCursor(walletId, position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLedgerCursor(cursor, walletId.toUpperCase())).toEqual(position);
    expect(() => decodeLedgerCursor(cursor, randomUUID())).toThrow(InvalidLedgerCursorError);
  });

  test('rejects malformed tokens, unsupported versions, invalid dates and oversized values', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const valid = { version: 1, walletId, ...position };
    for (const cursor of [
      '',
      '%%%',
      'a',
      'x'.repeat(1025),
      encode({}),
      encode({ ...valid, version: 2 }),
      encode({ ...valid, id: 'invalid' }),
      encode({ ...valid, createdAt: '2026-02-30T12:00:00.123456Z' }),
      encode({ ...valid, createdAt: '2026-10-15T12:00:00.123Z' }),
      encode({ ...valid, extra: true }),
    ]) {
      expect(() => decodeLedgerCursor(cursor, walletId)).toThrow(InvalidLedgerCursorError);
    }
  });

  test('looks ahead by one item and encodes the last returned item, not the extra row', async () => {
    const extra = { ...row, id: randomUUID(), createdAt: '2026-10-15T12:00:00.123455Z' };
    const findPage = mock(() => Promise.resolve([row, extra]));
    const useCase = new GetWalletLedgerUseCase(
      { findById: () => Promise.resolve(wallet) },
      { findPage },
    );
    const result = await useCase.execute({ walletId, limit: 1 });
    expect(findPage).toHaveBeenCalledWith(walletId, 2, undefined);
    expect(result.items).toEqual([row]);
    expect(decodeLedgerCursor(result.nextCursor!, walletId)).toEqual(position);
  });

  test('passes the decoded boundary to the reader and returns null at the end', async () => {
    const findPage = mock(() => Promise.resolve([row]));
    const useCase = new GetWalletLedgerUseCase(
      { findById: () => Promise.resolve(wallet) },
      { findPage },
    );
    const cursor = encodeLedgerCursor(walletId, position);
    const result = await useCase.execute({ walletId, limit: 1, cursor });
    expect(findPage).toHaveBeenCalledWith(walletId, 2, position);
    expect(result.nextCursor).toBeNull();
  });

  test('defaults to 50, distinguishes an empty wallet from a missing wallet and validates the limit', async () => {
    const findPage = mock(() => Promise.resolve([]));
    const useCase = new GetWalletLedgerUseCase(
      { findById: () => Promise.resolve(wallet) },
      { findPage },
    );
    expect(await useCase.execute({ walletId })).toEqual({ walletId, items: [], nextCursor: null });
    expect(findPage).toHaveBeenCalledWith(walletId, 51, undefined);
    for (const limit of [0, -1, 101, 1.5, NaN])
      expect(useCase.execute({ walletId, limit })).rejects.toBeInstanceOf(
        InvalidLedgerPaginationError,
      );
    expect(
      new GetWalletLedgerUseCase(
        { findById: () => Promise.resolve(undefined) },
        { findPage },
      ).execute({ walletId }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    await Bun.sleep(1);
  });
});
