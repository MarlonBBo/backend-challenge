import type { EntityManager } from '@mikro-orm/postgresql';

import {
  WagerTransactionStatus,
  type WagerTransaction,
  type WagerTransactionKind,
} from '../../../domain/wagering/wager-transaction';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';

export class WagerTransactionRepository {
  async insert(entityManager: EntityManager, transaction: WagerTransaction): Promise<void> {
    await entityManager.persist(WagerTransactionMapper.toEntity(transaction)).flush();
  }

  async findByIdempotencyKey(
    entityManager: EntityManager,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const entity = await entityManager.findOne(WagerTransactionEntity, { idempotencyKey });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }

  async findByExternalId(
    entityManager: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const entity = await entityManager.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }

  async findProcessedReversal(
    entityManager: EntityManager,
    referenceTransactionId: string,
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  ): Promise<WagerTransaction | undefined> {
    const entity = await entityManager.findOne(WagerTransactionEntity, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }
}
