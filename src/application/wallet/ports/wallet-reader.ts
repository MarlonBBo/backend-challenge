import type { Wallet } from '../../../domain/wallet/wallet';

export const WALLET_READER = Symbol('WALLET_READER');
export interface WalletReader {
  findById(id: string): Promise<Wallet | undefined>;
}
