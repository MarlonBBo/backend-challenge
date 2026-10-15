import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import type { Wallet } from '../../../domain/wallet/wallet';

export const WAGERING_UNIT_OF_WORK = Symbol('WAGERING_UNIT_OF_WORK');

export interface WageringTransactionContext {
  findTransactionByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  insertTransaction(transaction: WagerTransaction): Promise<void>;
  updateWallet(wallet: Wallet): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  insertOutboxMessages(messages: readonly OutboxMessage[]): Promise<void>;
}

export interface WageringUnitOfWork {
  execute<T>(work: (context: WageringTransactionContext) => Promise<T>): Promise<T>;
}

export class ConcurrentIdempotencyError extends Error {
  constructor() {
    super('A concurrent request inserted the same idempotency key');
    this.name = 'ConcurrentIdempotencyError';
  }
}

export class ConcurrentExternalTransactionError extends Error {
  constructor() {
    super('A concurrent request inserted the same external transaction');
    this.name = 'ConcurrentExternalTransactionError';
  }
}

export class ExternalTransactionAlreadyExistsError extends Error {
  readonly code = 'EXTERNAL_TRANSACTION_ALREADY_EXISTS';

  constructor(
    public readonly providerId: string,
    public readonly externalTransactionId: string,
  ) {
    super(`Transaction ${providerId}/${externalTransactionId} already exists`);
    this.name = 'ExternalTransactionAlreadyExistsError';
  }
}
