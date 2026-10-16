import { Global, Module } from '@nestjs/common';
import { APPLICATION_TELEMETRY } from '../../application/shared/telemetry';
import { ApplicationMetrics } from './application.metrics';
import { JsonLogger } from './json.logger';
import { TraceContext } from './trace-context';
import { MetricsController } from '../../presentation/http/metrics.controller';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    TraceContext,
    JsonLogger,
    ApplicationMetrics,
    { provide: APPLICATION_TELEMETRY, useExisting: ApplicationMetrics },
  ],
  exports: [APPLICATION_TELEMETRY, ApplicationMetrics, TraceContext, JsonLogger],
})
export class ObservabilityModule {}
