import { Inject, Injectable } from '@nestjs/common';
import { ResourceNotFoundError } from '../shared/resource-not-found.error';
import { WALLET_READER, type WalletReader } from './ports/wallet-reader';
import {
  WALLET_LEDGER_READER,
  type WalletLedgerReader,
  type LedgerEntryView,
} from './ports/wallet-ledger-reader';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';

export class InvalidLedgerPaginationError extends Error {
  readonly code = 'INVALID_PAGINATION';
  constructor() {
    super('Ledger limit must be an integer between 1 and 100');
    this.name = 'InvalidLedgerPaginationError';
  }
}

export interface GetWalletLedgerResult {
  readonly walletId: string;
  readonly items: readonly LedgerEntryView[];
  readonly nextCursor: string | null;
}

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(
    @Inject(WALLET_READER) private readonly wallets: WalletReader,
    @Inject(WALLET_LEDGER_READER) private readonly ledger: WalletLedgerReader,
  ) {}

  async execute(command: {
    readonly walletId: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<GetWalletLedgerResult> {
    const limit = command.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new InvalidLedgerPaginationError();
    const after =
      command.cursor === undefined
        ? undefined
        : decodeLedgerCursor(command.cursor, command.walletId);
    const wallet = await this.wallets.findById(command.walletId);
    if (wallet === undefined) throw new ResourceNotFoundError('wallet');
    const rows = await this.ledger.findPage(wallet.id, limit + 1, after);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return Object.freeze({
      walletId: wallet.id,
      items: Object.freeze(items),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeLedgerCursor(wallet.id, last) : null,
    });
  }
}
