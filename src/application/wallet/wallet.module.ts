import { Module } from '@nestjs/common';

import { MikroOrmCreateWalletUnitOfWork } from '../../infrastructure/database/unit-of-work/mikro-orm-create-wallet.unit-of-work';
import { WalletController } from '../../presentation/http/wallet.controller';
import { CreateWalletUseCase } from './create-wallet.use-case';
import { CREATE_WALLET_UNIT_OF_WORK } from './ports/create-wallet-unit-of-work';
import { GetWalletUseCase } from './get-wallet.use-case';
import { WALLET_READER } from './ports/wallet-reader';
import { MikroOrmWalletReader } from '../../infrastructure/database/queries/mikro-orm-wallet.reader';

@Module({
  controllers: [WalletController],
  providers: [
    CreateWalletUseCase,
    GetWalletUseCase,
    { provide: WALLET_READER, useClass: MikroOrmWalletReader },
    MikroOrmCreateWalletUnitOfWork,
    {
      provide: CREATE_WALLET_UNIT_OF_WORK,
      useExisting: MikroOrmCreateWalletUnitOfWork,
    },
  ],
})
export class WalletModule {}
