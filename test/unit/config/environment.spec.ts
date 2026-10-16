import { describe, expect, it } from 'bun:test';

import { getEnvironment } from '../../../src/config/environment';

const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '3000',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://wagering:wagering@localhost:5432/wagering',
  DATABASE_POOL_MIN: '1',
  DATABASE_POOL_MAX: '5',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_ENDPOINT: 'http://localhost:4566',
  SQS_WAGER_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  SQS_WAGER_DLQ_URL: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wager-events.fifo',
} as const;

describe('environment configuration', () => {
  it('validates outbox settings and supports disabling the publisher', () => {
    expect(getEnvironment(validEnvironment).outbox.batchSize).toBe(25);
    expect(
      getEnvironment({ ...validEnvironment, OUTBOX_WORKER_ENABLED: 'false' }).outbox.enabled,
    ).toBe(false);
    expect(() => getEnvironment({ ...validEnvironment, OUTBOX_WORKER_BATCH_SIZE: '101' })).toThrow(
      'Invalid environment configuration',
    );
    expect(() => getEnvironment({ ...validEnvironment, OUTBOX_WORKER_INTERVAL_MS: '0' })).toThrow(
      'Invalid environment configuration',
    );
  });
  it('validates SQS heartbeat and retry bounds', () => {
    expect(
      getEnvironment({ ...validEnvironment, SQS_CONSUMER_ENABLED: 'false' }).sqsConsumer.enabled,
    ).toBe(false);
    expect(() => getEnvironment({ ...validEnvironment, SQS_HEARTBEAT_MS: '30000' })).toThrow(
      'Invalid environment configuration',
    );
    expect(() => getEnvironment({ ...validEnvironment, SQS_RETRY_BASE_SECONDS: '400' })).toThrow(
      'Invalid environment configuration',
    );
  });
  it('parses retry settings and supports disabling the worker', () => {
    const environment = getEnvironment({
      ...validEnvironment,
      REFERENCE_WORKER_ENABLED: 'false',
      REFERENCE_MAX_ATTEMPTS: '5',
    });
    expect(environment.references.enabled).toBe(false);
    expect(environment.references.maxAttempts).toBe(5);
    expect(environment.references.ttlMs).toBe(86_400_000);
  });

  it('rejects invalid retry settings', () => {
    for (const overrides of [
      { REFERENCE_MAX_ATTEMPTS: '0' },
      { REFERENCE_WORKER_ENABLED: 'no' },
      { REFERENCE_BASE_DELAY_MS: '5000', REFERENCE_MAX_DELAY_MS: '1000' },
    ]) {
      expect(() => getEnvironment({ ...validEnvironment, ...overrides })).toThrow(
        'Invalid environment configuration',
      );
    }
  });
  it('parses and groups valid environment values', () => {
    const environment = getEnvironment(validEnvironment);

    expect(environment.port).toBe(3000);
    expect(environment.database.poolMin).toBe(1);
    expect(environment.database.poolMax).toBe(5);
    expect(environment.aws.region).toBe('us-east-1');
  });

  it('rejects an invalid database URL', () => {
    expect(() =>
      getEnvironment({
        ...validEnvironment,
        DATABASE_URL: 'mysql://localhost/database',
      }),
    ).toThrow('Invalid environment configuration');
  });

  it('rejects a minimum pool larger than the maximum', () => {
    expect(() =>
      getEnvironment({
        ...validEnvironment,
        DATABASE_POOL_MIN: '10',
        DATABASE_POOL_MAX: '2',
      }),
    ).toThrow('DATABASE_POOL_MIN must be <= DATABASE_POOL_MAX');
  });
});
