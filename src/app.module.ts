import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './presentation/http/app.controller';
import { validateEnvironment } from './config/environment';
import { DatabaseModule } from './infrastructure/database/database.module';
import { WalletModule } from './application/wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      expandVariables: false,
      isGlobal: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    WalletModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
