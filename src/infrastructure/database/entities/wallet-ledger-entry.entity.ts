import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

import { LedgerDirection } from '../../../domain/ledger/ledger-direction';

@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'string', length: 8 })
  direction!: LedgerDirection;

  @Property({ columnType: 'numeric(20,2)' })
  amount!: string;

  @Property({ columnType: 'char(3)' })
  currency!: string;

  @Property({ fieldName: 'balance_before', columnType: 'numeric(20,2)' })
  balanceBefore!: string;

  @Property({ fieldName: 'balance_after', columnType: 'numeric(20,2)' })
  balanceAfter!: string;

  @Property({ fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;
}
