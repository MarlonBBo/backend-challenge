import type { EntityManager } from '@mikro-orm/postgresql';

import {
  WagerTransactionStatus,
  type WagerTransaction,
  type WagerTransactionKind,
} from '../../../domain/wagering/wager-transaction';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';

export class WagerTransactionRepository {
  async findById(entityManager: EntityManager, id: string): Promise<WagerTransaction | undefined> {
    const entity = await entityManager.findOne(WagerTransactionEntity, { id });
    return entity === null ? undefined : WagerTransactionMapper.toDomain(entity);
  }

  async findNextPendingForUpdate(
    entityManager: EntityManager,
    now: Date,
  ): Promise<WagerTransaction | undefined> {
    // Bloqueie a carteira primeiro, assim como faz o processamento HTTP. 
    // Outros processos ignoram carteiras que estejam ocupadas.
    const rows = await entityManager.execute<{ id: string }[]>(
      `
      select t.id
      from wager_transactions t
      join wallets w on w.id = t.wallet_id
      where t.status = 'PENDING_REFERENCE'
        and (t.next_reference_attempt_at <= ? or t.next_reference_attempt_at is null)
      order by t.next_reference_attempt_at nulls first, t.created_at, t.id
      limit 1
      for update of w skip locked
    `,
      [now],
    );
    if (rows[0] === undefined) {
      return undefined;
    }
    const entity = await entityManager.findOne(
      WagerTransactionEntity,
      { id: rows[0].id },
      { refresh: true },
    );
    if (
      entity === null ||
      entity.status !== WagerTransactionStatus.PendingReference ||
      (entity.nextReferenceAttemptAt !== null && entity.nextReferenceAttemptAt > now)
    ) {
      return undefined;
    }
    return WagerTransactionMapper.toDomain(entity);
  }

  async update(entityManager: EntityManager, transaction: WagerTransaction): Promise<void> {
    const entity = WagerTransactionMapper.toEntity(transaction);
    const affectedRows = await entityManager.nativeUpdate(
      WagerTransactionEntity,
      {
        id: transaction.id,
        status: WagerTransactionStatus.PendingReference,
      },
      {
        status: entity.status,
        referenceTransactionId: entity.referenceTransactionId,
        failureCode: entity.failureCode,
        resultBalance: entity.resultBalance,
        referenceAttempts: entity.referenceAttempts,
        nextReferenceAttemptAt: entity.nextReferenceAttemptAt,
        processedAt: entity.processedAt,
      },
    );
    if (affectedRows !== 1) {
      throw new Error(`Pending transaction ${transaction.id} changed while being processed`);
    }
  }

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
