import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import type { Wallet } from '../../../domain/wallet/wallet';

export const CREATE_WALLET_UNIT_OF_WORK = Symbol('CREATE_WALLET_UNIT_OF_WORK');

export interface CreateWalletPersistenceBundle {
  readonly wallet: Wallet;
  readonly openingTransaction?: WagerTransaction;
  readonly openingLedgerEntry?: WalletLedgerEntry;
  readonly outboxMessages: readonly OutboxMessage[];
}

export interface CreateWalletUnitOfWork {
  create(bundle: CreateWalletPersistenceBundle): Promise<void>;
}

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(
    public readonly playerId: string,
    public readonly currency: string,
  ) {
    super(`Wallet already exists for player ${playerId} and currency ${currency}`);
    this.name = 'WalletAlreadyExistsError';
  }
}
