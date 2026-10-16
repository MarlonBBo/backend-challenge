import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { TraceContext } from './trace-context';

const keys = new Set([
  'message',
  'eventId',
  'correlationId',
  'messageId',
  'transactionId',
  'walletId',
  'providerId',
  'status',
  'failureCode',
  'code',
  'idempotentReplay',
  'receiveCount',
  'selected',
  'published',
  'failed',
  'pending',
  'oldestPendingAgeMs',
  'failedAttempts',
  'lagMs',
  'events',
]);
function safe(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (Array.isArray(value)) return value.map((item: unknown) => safe(item));
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => keys.has(key))
        .map(([key, item]) => [key, safe(item)]),
    );
  return undefined;
}

@Injectable()
export class JsonLogger implements LoggerService {
  constructor(@Inject(TraceContext) private readonly trace: TraceContext) {}
  log(message: unknown, ...context: unknown[]) {
    this.write('info', message, context);
  }
  error(message: unknown, ...context: unknown[]) {
    this.write('error', message, context);
  }
  warn(message: unknown, ...context: unknown[]) {
    this.write('warn', message, context);
  }
  debug(message: unknown, ...context: unknown[]) {
    this.write('debug', message, context);
  }
  verbose(message: unknown, ...context: unknown[]) {
    this.write('trace', message, context);
  }
  fatal(message: unknown, ...context: unknown[]) {
    this.write('fatal', message, context);
  }
  private write(level: string, message: unknown, context: unknown[]) {
    const ranks: Record<string, number> = {
      trace: 0,
      debug: 1,
      info: 2,
      warn: 3,
      error: 4,
      fatal: 5,
    };
    if ((ranks[level] ?? 2) < (ranks[process.env.LOG_LEVEL ?? 'info'] ?? 2)) return;
    const content =
      message instanceof Error
        ? { message: 'Unhandled application error', errorType: message.name }
        : typeof message === 'string'
          ? { message }
          : safe(message);
    const fields =
      content !== null && typeof content === 'object' ? content : { message: 'Application event' };
    // Optional error stacks and arbitrary payload fields are intentionally omitted.
    const last = context.at(-1);
    process.stdout.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), level, ...(typeof last === 'string' && !last.includes('\n') ? { context: last } : {}), ...this.trace.fields, ...fields })}\n`,
    );
  }
}
