import type { EntityManager } from '@mikro-orm/postgresql';

import type { Wallet } from '../../../domain/wallet/wallet';
import { WalletMapper } from '../mappers/wallet.mapper';

export class WalletRepository {
  async insert(entityManager: EntityManager, wallet: Wallet): Promise<void> {
    await entityManager.persist(WalletMapper.toEntity(wallet)).flush();
  }
}
