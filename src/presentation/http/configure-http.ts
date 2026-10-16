import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type INestApplication, RequestMethod } from '@nestjs/common';
import { TraceContext } from '../../infrastructure/observability/trace-context';
import { ApplicationMetrics } from '../../infrastructure/observability/application.metrics';

export function configureHttp(app: INestApplication): void {
  app.setGlobalPrefix('api', {
    exclude: ['health/live', 'health/ready', 'metrics'].map((path) => ({
      path,
      method: RequestMethod.GET,
    })),
  });
  const trace = app.get(TraceContext);
  const metrics = app.get(ApplicationMetrics);
  app.use((request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const header = request.headers['x-correlation-id'];
    const correlationId =
      typeof header === 'string' && header.trim().length > 0 && header.length <= 255
        ? header
        : randomUUID();
    request.headers['x-correlation-id'] = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    const started = performance.now();
    response.once('finish', () =>
      metrics.observe('http_request_duration_seconds', (performance.now() - started) / 1000),
    );
    trace.run({ correlationId }, next);
  });
}
