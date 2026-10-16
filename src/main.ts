import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { getEnvironment } from './config/environment';
import { JsonLogger } from './infrastructure/observability/json.logger';
import { configureHttp } from './presentation/http/configure-http';

async function bootstrap(): Promise<void> {
  const environment = getEnvironment(process.env);
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.enableShutdownHooks();
  app.useLogger(app.get(JsonLogger));
  configureHttp(app);

  await app.listen(environment.port, '0.0.0.0');
}

void bootstrap();
