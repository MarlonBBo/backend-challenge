import type { EntityManager } from '@mikro-orm/postgresql';

import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';

export class WagerTransactionRepository {
  async insert(entityManager: EntityManager, transaction: WagerTransaction): Promise<void> {
    await entityManager.persist(WagerTransactionMapper.toEntity(transaction)).flush();
  }
}
