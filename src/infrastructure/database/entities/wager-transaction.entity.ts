import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

import { FailureCode } from '../../../domain/wagering/failure-code';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'string', length: 100 })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', type: 'string', length: 255 })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key', type: 'string', length: 255 })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', columnType: 'char(64)' })
  payloadHash!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ fieldName: 'round_id', type: 'string', length: 255 })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'string', length: 255 })
  gameId!: string;

  @Property({ type: 'string', length: 16 })
  kind!: WagerTransactionKind;

  @Property({ type: 'string', length: 32 })
  status!: WagerTransactionStatus;

  @Property({ columnType: 'numeric(20,2)' })
  amount!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Property({
    fieldName: 'reference_external_transaction_id',
    type: 'string',
    length: 255,
    nullable: true,
  })
  referenceExternalTransactionId: string | null = null;

  @Property({ fieldName: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId: string | null = null;

  @Property({ fieldName: 'failure_code', type: 'string', length: 64, nullable: true })
  failureCode: FailureCode | null = null;

  @Property({ fieldName: 'result_balance', columnType: 'numeric(20,2)', nullable: true })
  resultBalance: string | null = null;

  @Property({ fieldName: 'reference_attempts', type: 'integer' })
  referenceAttempts = 0;

  @Property({ fieldName: 'next_reference_attempt_at', columnType: 'timestamptz', nullable: true })
  nextReferenceAttemptAt: Date | null = null;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'processed_at', columnType: 'timestamptz', nullable: true })
  processedAt: Date | null = null;
}
