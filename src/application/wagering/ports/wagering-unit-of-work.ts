import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import type {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../domain/wagering/wager-transaction';
import type { Wallet } from '../../../domain/wallet/wallet';
import type { InboxMessage } from '../../../domain/messaging/inbox-message';
import type { InboxDelivery } from './inbox-delivery';

export const WAGERING_UNIT_OF_WORK = Symbol('WAGERING_UNIT_OF_WORK');

export interface WageringTransactionContext {
  findCorrelationId(transactionId: string): Promise<string | undefined>;
  receiveInbox(delivery: InboxDelivery): Promise<InboxMessage>;
  completeInbox(message: InboxMessage): Promise<void>;
  findTransactionByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  ): Promise<WagerTransaction | undefined>;
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  insertTransaction(transaction: WagerTransaction): Promise<void>;
  updateTransaction(transaction: WagerTransaction): Promise<void>;
  updateWallet(wallet: Wallet): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  insertOutboxMessages(messages: readonly OutboxMessage[]): Promise<void>;
}

export interface WageringUnitOfWork {
  execute<T>(work: (context: WageringTransactionContext) => Promise<T>): Promise<T>;
  executeNextPending<T>(
    now: Date,
    work: (
      context: WageringTransactionContext,
      transaction: WagerTransaction,
      wallet: Wallet,
    ) => Promise<T>,
  ): Promise<T | undefined>;
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
