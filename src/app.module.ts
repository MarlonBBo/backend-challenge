import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './presentation/http/app.controller';
import { validateEnvironment } from './config/environment';
import { DatabaseModule } from './infrastructure/database/database.module';
import { WalletModule } from './application/wallet/wallet.module';
import { WageringModule } from './application/wagering/wagering.module';
import { OutboxModule } from './application/messaging/outbox.module';
import { HealthModule } from './application/health/health.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { APP_GUARD } from '@nestjs/core';
import { ProviderAuthGuard } from './presentation/http/provider-auth.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      expandVariables: false,
      isGlobal: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    ObservabilityModule,
    HealthModule,
    WalletModule,
    WageringModule,
    OutboxModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: ProviderAuthGuard }],
})
export class AppModule {}
