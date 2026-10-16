import { Module } from '@nestjs/common';

import { MikroOrmCreateWalletUnitOfWork } from '../../infrastructure/database/unit-of-work/mikro-orm-create-wallet.unit-of-work';
import { WalletController } from '../../presentation/http/wallet.controller';
import { CreateWalletUseCase } from './create-wallet.use-case';
import { CREATE_WALLET_UNIT_OF_WORK } from './ports/create-wallet-unit-of-work';
import { GetWalletUseCase } from './get-wallet.use-case';
import { WALLET_READER } from './ports/wallet-reader';
import { MikroOrmWalletReader } from '../../infrastructure/database/queries/mikro-orm-wallet.reader';
import { GetWalletLedgerUseCase } from './get-wallet-ledger.use-case';
import { WALLET_LEDGER_READER } from './ports/wallet-ledger-reader';
import { MikroOrmWalletLedgerReader } from '../../infrastructure/database/queries/mikro-orm-wallet-ledger.reader';
import { WalletLedgerController } from '../../presentation/http/wallet-ledger.controller';
import { WalletReconciliationController } from '../../presentation/http/wallet-reconciliation.controller';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case';
import { WALLET_RECONCILIATION_READER } from './ports/wallet-reconciliation-reader';
import { MikroOrmWalletReconciliationReader } from '../../infrastructure/database/queries/mikro-orm-wallet-reconciliation.reader';

@Module({
  controllers: [WalletController, WalletLedgerController, WalletReconciliationController],
  providers: [
    CreateWalletUseCase,
    GetWalletUseCase,
    ReconcileWalletUseCase,
    { provide: WALLET_RECONCILIATION_READER, useClass: MikroOrmWalletReconciliationReader },
    GetWalletLedgerUseCase,
    { provide: WALLET_LEDGER_READER, useClass: MikroOrmWalletLedgerReader },
    { provide: WALLET_READER, useClass: MikroOrmWalletReader },
    MikroOrmCreateWalletUnitOfWork,
    {
      provide: CREATE_WALLET_UNIT_OF_WORK,
      useExisting: MikroOrmCreateWalletUnitOfWork,
    },
  ],
})
export class WalletModule {}
