import { Money } from '../../../domain/shared/value-objects/money';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import { WagerTransactionEntity } from '../entities/wager-transaction.entity';

export class WagerTransactionMapper {
  static toEntity(transaction: WagerTransaction): WagerTransactionEntity {
    const entity = new WagerTransactionEntity();
    entity.id = transaction.id;
    entity.providerId = transaction.providerId;
    entity.externalTransactionId = transaction.externalTransactionId;
    entity.idempotencyKey = transaction.idempotencyKey;
    entity.payloadHash = transaction.payloadHash;
    entity.walletId = transaction.walletId;
    entity.playerId = transaction.playerId;
    entity.roundId = transaction.roundId;
    entity.gameId = transaction.gameId;
    entity.kind = transaction.kind;
    entity.status = transaction.status;
    entity.amount = transaction.money.toJSON().amount;
    entity.currency = transaction.money.currency;
    entity.referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
    entity.referenceTransactionId = transaction.referenceTransactionId ?? null;
    entity.failureCode = transaction.failureCode ?? null;
    entity.createdAt = transaction.createdAt;
    entity.processedAt = transaction.processedAt ?? null;
    return entity;
  }

  static toDomain(entity: WagerTransactionEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      kind: entity.kind,
      money: Money.from({ amount: entity.amount, currency: entity.currency }),
      referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
      createdAt: entity.createdAt,
      status: entity.status,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      failureCode: entity.failureCode ?? undefined,
      processedAt: entity.processedAt ?? undefined,
    });
  }
}
