import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type {
  WalletLedgerReader,
  LedgerPosition,
} from '../../../application/wallet/ports/wallet-ledger-reader';
import { WalletLedgerEntryRepository } from '../repositories/wallet-ledger-entry.repository';

@Injectable()
export class MikroOrmWalletLedgerReader implements WalletLedgerReader {
  private readonly ledger = new WalletLedgerEntryRepository();
  constructor(@Inject(EntityManager) private readonly entityManager: EntityManager) {}
  findPage(walletId: string, take: number, after?: LedgerPosition) {
    return this.ledger.findPage(this.entityManager.fork(), walletId, take, after);
  }
}
