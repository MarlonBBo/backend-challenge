import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import type { Wallet } from '../../../domain/wallet/wallet';
import { WalletEntity } from '../entities/wallet.entity';
import { WalletMapper } from '../mappers/wallet.mapper';
import { NOOP_TELEMETRY, type ApplicationTelemetry } from '../../../application/shared/telemetry';

export class ConcurrentWalletUpdateError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} changed while it was being processed`);
    this.name = 'ConcurrentWalletUpdateError';
  }
}

export class WalletRepository {
  constructor(private readonly telemetry: ApplicationTelemetry = NOOP_TELEMETRY) {}
  async findById(entityManager: EntityManager, id: string): Promise<Wallet | undefined> {
    const entity = await entityManager.findOne(WalletEntity, { id });
    return entity === null ? undefined : WalletMapper.toDomain(entity);
  }

  async insert(entityManager: EntityManager, wallet: Wallet): Promise<void> {
    await entityManager.persist(WalletMapper.toEntity(wallet)).flush();
  }

  async findByIdForUpdate(
    entityManager: EntityManager,
    walletId: string,
  ): Promise<Wallet | undefined> {
    const started = performance.now();
    const entity = await entityManager.findOne(
      WalletEntity,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    this.telemetry.observe('wallet_lock_wait_seconds', (performance.now() - started) / 1000);

    return entity === null ? undefined : WalletMapper.toDomain(entity);
  }

  async update(entityManager: EntityManager, wallet: Wallet): Promise<void> {
    const affectedRows = await entityManager.nativeUpdate(
      WalletEntity,
      { id: wallet.id, version: wallet.version - 1 },
      {
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );

    if (affectedRows !== 1) {
      this.telemetry.increment('wallet_lock_conflicts_total');
      throw new ConcurrentWalletUpdateError(wallet.id);
    }
  }
}
