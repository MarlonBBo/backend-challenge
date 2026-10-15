export class WagerIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(public readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used with a different payload`);
    this.name = 'WagerIdempotencyConflictError';
  }
}

export class WagerWalletNotFoundError extends Error {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(public readonly walletId: string) {
    super(`Wallet ${walletId} was not found`);
    this.name = 'WagerWalletNotFoundError';
  }
}

export class MissingTransactionResultError extends Error {
  readonly code = 'MISSING_TRANSACTION_RESULT';

  constructor(public readonly transactionId: string) {
    super(`Transaction ${transactionId} does not have a persisted result balance`);
    this.name = 'MissingTransactionResultError';
  }
}
