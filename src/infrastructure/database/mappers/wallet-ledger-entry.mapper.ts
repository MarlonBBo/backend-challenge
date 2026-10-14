import { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../../domain/shared/value-objects/money';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity';

export class WalletLedgerEntryMapper {
  static toEntity(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
    const entity = new WalletLedgerEntryEntity();
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.direction = entry.direction;
    entity.amount = entry.money.toJSON().amount;
    entity.currency = entry.money.currency;
    entity.balanceBefore = entry.balanceBefore.toJSON().amount;
    entity.balanceAfter = entry.balanceAfter.toJSON().amount;
    entity.createdAt = entry.createdAt;
    return entity;
  }

  static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    const money = (amount: string): Money => Money.from({ amount, currency: entity.currency });

    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction,
      money: money(entity.amount),
      balanceBefore: money(entity.balanceBefore),
      balanceAfter: money(entity.balanceAfter),
      createdAt: entity.createdAt,
    });
  }
}
