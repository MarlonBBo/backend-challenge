export class ResourceNotFoundError extends Error {
  readonly code: string;
  constructor(resource: 'wallet' | 'transaction') {
    super(resource === 'wallet' ? 'Wallet not found' : 'Wager transaction not found');
    this.name = 'ResourceNotFoundError';
    this.code = resource === 'wallet' ? 'WALLET_NOT_FOUND' : 'TRANSACTION_NOT_FOUND';
  }
}
