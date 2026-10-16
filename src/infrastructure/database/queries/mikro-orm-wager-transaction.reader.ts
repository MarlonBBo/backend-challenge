import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionReader } from '../../../application/wagering/ports/wager-transaction-reader';
import { WagerTransactionRepository } from '../repositories/wager-transaction.repository';

@Injectable()
export class MikroOrmWagerTransactionReader implements WagerTransactionReader {
  private readonly transactions = new WagerTransactionRepository();
  constructor(@Inject(EntityManager) private readonly entityManager: EntityManager) {}
  findById(id: string) {
    return this.transactions.findById(this.entityManager.fork(), id);
  }
  findByExternalId(providerId: string, externalTransactionId: string) {
    return this.transactions.findByExternalId(
      this.entityManager.fork(),
      providerId,
      externalTransactionId,
    );
  }
}
