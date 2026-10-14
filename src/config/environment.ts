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
});

export type Environment = Readonly<{
  nodeEnv: z.infer<typeof environmentSchema>['NODE_ENV'];
  port: number;
  logLevel: z.infer<typeof environmentSchema>['LOG_LEVEL'];
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

  return Object.freeze({
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    logLevel: result.data.LOG_LEVEL,
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
