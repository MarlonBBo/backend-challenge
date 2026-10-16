import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type { WalletReader } from '../../../application/wallet/ports/wallet-reader';
import { WalletRepository } from '../repositories/wallet.repository';

@Injectable()
export class MikroOrmWalletReader implements WalletReader {
  private readonly wallets = new WalletRepository();
  constructor(@Inject(EntityManager) private readonly entityManager: EntityManager) {}
  findById(id: string) {
    return this.wallets.findById(this.entityManager.fork(), id);
  }
}
