export const WALLET_RECONCILIATION_READER = Symbol('WALLET_RECONCILIATION_READER');
export interface WalletReconciliationSnapshot {
  readonly walletId: string;
  readonly currency: string;
  readonly storedBalance: string;
  readonly calculatedBalance: string;
  readonly difference: string;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly currencyMismatchEntries: number;
  readonly checkedAt: string;
}
export interface WalletReconciliationReader {
  read(walletId: string): Promise<WalletReconciliationSnapshot | undefined>;
}
