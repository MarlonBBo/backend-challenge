import { Module } from '@nestjs/common';
import { READINESS_PROBE } from './readiness-probe';
import { DatabaseSqsReadinessProbe } from '../../infrastructure/health/database-sqs-readiness.probe';
import { HealthController } from '../../presentation/http/health.controller';
@Module({
  controllers: [HealthController],
  providers: [{ provide: READINESS_PROBE, useClass: DatabaseSqsReadinessProbe }],
})
export class HealthModule {}
