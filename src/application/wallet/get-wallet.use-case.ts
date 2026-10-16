import { Inject, Injectable } from '@nestjs/common';
import { WALLET_READER, type WalletReader } from './ports/wallet-reader';
import { ResourceNotFoundError } from '../shared/resource-not-found.error';

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(WALLET_READER) private readonly wallets: WalletReader) {}

  async execute(walletId: string) {
    const wallet = await this.wallets.findById(walletId);
    if (wallet === undefined) throw new ResourceNotFoundError('wallet');
    return Object.freeze({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    });
  }
}
