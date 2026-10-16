import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';

export const WAGER_TRANSACTION_READER = Symbol('WAGER_TRANSACTION_READER');
export interface WagerTransactionReader {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
}
