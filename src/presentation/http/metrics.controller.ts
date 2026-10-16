import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ApplicationMetrics } from '../../infrastructure/observability/application.metrics';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(ApplicationMetrics) private readonly metrics: ApplicationMetrics) {}
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  get() {
    return this.metrics.render();
  }
}
