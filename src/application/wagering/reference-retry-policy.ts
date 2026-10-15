export interface ReferenceRetryOptions {
  readonly maxAttempts: number;
  readonly ttlMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export class ReferenceRetryPolicy {
  constructor(
    readonly options: ReferenceRetryOptions = {
      maxAttempts: 20,
      ttlMs: 86_400_000,
      baseDelayMs: 1_000,
      maxDelayMs: 300_000,
    },
  ) {}

  isExpired(createdAt: Date, attempts: number, now: Date): boolean {
    return attempts >= this.options.maxAttempts || now.getTime() >= this.expiresAt(createdAt);
  }

  nextAttemptAt(createdAt: Date, attempts: number, now: Date): Date {
    const delay = Math.min(
      this.options.baseDelayMs * 2 ** Math.min(attempts, 30),
      this.options.maxDelayMs,
    );
    return new Date(Math.min(now.getTime() + delay, this.expiresAt(createdAt)));
  }

  private expiresAt(createdAt: Date): number {
    return createdAt.getTime() + this.options.ttlMs;
  }
}
