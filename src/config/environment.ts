import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url().startsWith('postgresql://'),
  DATABASE_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  SQS_ENDPOINT: z.url(),
  SQS_WAGER_QUEUE_URL: z.url(),
  SQS_WAGER_DLQ_URL: z.url(),
  SQS_EVENTS_QUEUE_URL: z.url(),
  OUTBOX_WORKER_ENABLED: z.enum(['true', 'false']).default('true'),
  OUTBOX_WORKER_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  OUTBOX_WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(25),
  SQS_CONSUMER_ENABLED: z.enum(['true', 'false']).default('true'),
  SQS_VISIBILITY_SECONDS: z.coerce.number().int().min(3).max(43_200).default(30),
  SQS_HEARTBEAT_MS: z.coerce.number().int().min(100).default(10_000),
  SQS_RETRY_BASE_SECONDS: z.coerce.number().int().positive().default(1),
  SQS_RETRY_MAX_SECONDS: z.coerce.number().int().positive().max(43_200).default(300),
  REFERENCE_WORKER_ENABLED: z.enum(['true', 'false']).default('true'),
  REFERENCE_WORKER_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  REFERENCE_WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(25),
  REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().positive().max(1_000).default(20),
  REFERENCE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  REFERENCE_BASE_DELAY_MS: z.coerce.number().int().positive().default(1_000),
  REFERENCE_MAX_DELAY_MS: z.coerce.number().int().positive().default(300_000),
});

export type Environment = Readonly<{
  nodeEnv: z.infer<typeof environmentSchema>['NODE_ENV'];
  port: number;
  logLevel: z.infer<typeof environmentSchema>['LOG_LEVEL'];
  outbox: Readonly<{ enabled: boolean; intervalMs: number; batchSize: number }>;
  sqsConsumer: Readonly<{
    enabled: boolean;
    visibilitySeconds: number;
    heartbeatMs: number;
    retryBaseSeconds: number;
    retryMaxSeconds: number;
  }>;
  references: Readonly<{
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    maxAttempts: number;
    ttlMs: number;
    baseDelayMs: number;
    maxDelayMs: number;
  }>;
  database: Readonly<{
    url: string;
    poolMin: number;
    poolMax: number;
  }>;
  aws: Readonly<{
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sqsEndpoint: string;
    wagerQueueUrl: string;
    wagerDlqUrl: string;
    eventsQueueUrl: string;
  }>;
}>;

function formatEnvironmentError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('; ');
}

export function getEnvironment(values: NodeJS.ProcessEnv | Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(values);

  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${formatEnvironmentError(result.error)}`);
  }

  if (result.data.DATABASE_POOL_MIN > result.data.DATABASE_POOL_MAX) {
    throw new Error(
      'Invalid environment configuration: DATABASE_POOL_MIN must be <= DATABASE_POOL_MAX',
    );
  }

  if (result.data.REFERENCE_BASE_DELAY_MS > result.data.REFERENCE_MAX_DELAY_MS) {
    throw new Error(
      'Invalid environment configuration: REFERENCE_BASE_DELAY_MS must be <= REFERENCE_MAX_DELAY_MS',
    );
  }

  if (
    result.data.SQS_HEARTBEAT_MS >= result.data.SQS_VISIBILITY_SECONDS * 1_000 ||
    result.data.SQS_RETRY_BASE_SECONDS > result.data.SQS_RETRY_MAX_SECONDS
  ) {
    throw new Error(
      'Invalid environment configuration: SQS heartbeat must precede visibility expiration and retry base must not exceed its maximum',
    );
  }

  return Object.freeze({
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    logLevel: result.data.LOG_LEVEL,
    outbox: Object.freeze({
      enabled: result.data.OUTBOX_WORKER_ENABLED === 'true',
      intervalMs: result.data.OUTBOX_WORKER_INTERVAL_MS,
      batchSize: result.data.OUTBOX_WORKER_BATCH_SIZE,
    }),
    sqsConsumer: Object.freeze({
      enabled: result.data.SQS_CONSUMER_ENABLED === 'true',
      visibilitySeconds: result.data.SQS_VISIBILITY_SECONDS,
      heartbeatMs: result.data.SQS_HEARTBEAT_MS,
      retryBaseSeconds: result.data.SQS_RETRY_BASE_SECONDS,
      retryMaxSeconds: result.data.SQS_RETRY_MAX_SECONDS,
    }),
    references: Object.freeze({
      enabled: result.data.REFERENCE_WORKER_ENABLED === 'true',
      intervalMs: result.data.REFERENCE_WORKER_INTERVAL_MS,
      batchSize: result.data.REFERENCE_WORKER_BATCH_SIZE,
      maxAttempts: result.data.REFERENCE_MAX_ATTEMPTS,
      ttlMs: result.data.REFERENCE_TTL_MS,
      baseDelayMs: result.data.REFERENCE_BASE_DELAY_MS,
      maxDelayMs: result.data.REFERENCE_MAX_DELAY_MS,
    }),
    database: Object.freeze({
      url: result.data.DATABASE_URL,
      poolMin: result.data.DATABASE_POOL_MIN,
      poolMax: result.data.DATABASE_POOL_MAX,
    }),
    aws: Object.freeze({
      region: result.data.AWS_REGION,
      accessKeyId: result.data.AWS_ACCESS_KEY_ID,
      secretAccessKey: result.data.AWS_SECRET_ACCESS_KEY,
      sqsEndpoint: result.data.SQS_ENDPOINT,
      wagerQueueUrl: result.data.SQS_WAGER_QUEUE_URL,
      wagerDlqUrl: result.data.SQS_WAGER_DLQ_URL,
      eventsQueueUrl: result.data.SQS_EVENTS_QUEUE_URL,
    }),
  });
}

export function validateEnvironment(values: Record<string, unknown>): Record<string, unknown> {
  getEnvironment(values);
  return values;
}
