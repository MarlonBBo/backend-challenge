import { Module } from '@nestjs/common';

import { MikroOrmCreateWalletUnitOfWork } from '../../infrastructure/database/unit-of-work/mikro-orm-create-wallet.unit-of-work';
import { WalletController } from '../../presentation/http/wallet.controller';
import { CreateWalletUseCase } from './create-wallet.use-case';
import { CREATE_WALLET_UNIT_OF_WORK } from './ports/create-wallet-unit-of-work';

@Module({
  controllers: [WalletController],
  providers: [
    CreateWalletUseCase,
    MikroOrmCreateWalletUnitOfWork,
    {
      provide: CREATE_WALLET_UNIT_OF_WORK,
      useExisting: MikroOrmCreateWalletUnitOfWork,
    },
  ],
})
export class WalletModule {}
