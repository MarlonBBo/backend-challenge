import { Inject, Injectable } from '@nestjs/common';
import {
  WAGER_TRANSACTION_READER,
  type WagerTransactionReader,
} from './ports/wager-transaction-reader';
import { ResourceNotFoundError } from '../shared/resource-not-found.error';

export type WagerTransactionLookup =
  | { readonly transactionId: string }
  | { readonly providerId: string; readonly externalTransactionId: string };

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_READER) private readonly transactions: WagerTransactionReader,
  ) {}

  async execute(lookup: WagerTransactionLookup) {
    const transaction =
      'transactionId' in lookup
        ? await this.transactions.findById(lookup.transactionId)
        : await this.transactions.findByExternalId(lookup.providerId, lookup.externalTransactionId);
    if (transaction === undefined) throw new ResourceNotFoundError('transaction');
    return Object.freeze({
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      status: transaction.status,
      money: transaction.money.toJSON(),
      balance: transaction.resultBalance?.toJSON() ?? null,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      failureCode: transaction.failureCode ?? null,
      referenceAttempts: transaction.referenceAttempts,
      nextReferenceAttemptAt: transaction.nextReferenceAttemptAt?.toISOString() ?? null,
      createdAt: transaction.createdAt.toISOString(),
      processedAt: transaction.processedAt?.toISOString() ?? null,
    });
  }
}
