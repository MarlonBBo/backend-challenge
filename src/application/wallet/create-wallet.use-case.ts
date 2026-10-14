import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { WalletBalanceChanged } from '../../domain/events/wallet-events';
import { WagerTransactionProcessed } from '../../domain/events/wagering-events';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/shared/value-objects/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { sha256CanonicalJson } from '../shared/canonical-json';
import {
  CREATE_WALLET_UNIT_OF_WORK,
  type CreateWalletUnitOfWork,
} from './ports/create-wallet-unit-of-work';

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId: string;
}

export interface CreateWalletResult {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Readonly<MoneyProps>;
  readonly version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(CREATE_WALLET_UNIT_OF_WORK)
    private readonly unitOfWork: CreateWalletUnitOfWork,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Readonly<CreateWalletResult>> {
    const now = new Date();
    const initialBalance = Money.from(command.initialBalance);
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: command.playerId,
      initialBalance,
      createdAt: now,
    });

    if (initialBalance.isZero()) {
      await this.unitOfWork.create({ wallet, outboxMessages: [] });
      return CreateWalletUseCase.resultFrom(wallet);
    }

    const openingTransaction = WagerTransaction.createOpening({
      id: randomUUID(),
      payloadHash: sha256CanonicalJson({
        operation: 'wallet-opening',
        playerId: command.playerId,
        initialBalance: initialBalance.toJSON(),
      }),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: initialBalance,
      createdAt: now,
    });
    openingTransaction.markProcessed(undefined, now);

    const openingLedgerEntry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: openingTransaction.id,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
      createdAt: now,
    });

    const transactionProcessed = WagerTransactionProcessed.from(openingTransaction, {
      eventId: randomUUID(),
      correlationId: command.correlationId,
      causationId: openingTransaction.id,
      occurredAt: now,
    });
    const balanceChanged = WalletBalanceChanged.from(wallet, openingLedgerEntry, {
      eventId: randomUUID(),
      correlationId: command.correlationId,
      causationId: openingTransaction.id,
      occurredAt: now,
    });

    await this.unitOfWork.create({
      wallet,
      openingTransaction,
      openingLedgerEntry,
      outboxMessages: [
        OutboxMessage.enqueue(transactionProcessed),
        OutboxMessage.enqueue(balanceChanged),
      ],
    });

    return CreateWalletUseCase.resultFrom(wallet);
  }

  private static resultFrom(wallet: Wallet): Readonly<CreateWalletResult> {
    return Object.freeze({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    });
  }
}
