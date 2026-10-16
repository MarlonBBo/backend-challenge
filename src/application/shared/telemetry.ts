export const APPLICATION_TELEMETRY = Symbol('APPLICATION_TELEMETRY');
export type TraceFields = Readonly<{
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}>;
export interface ApplicationTelemetry {
  increment(name: string, labels?: Readonly<Record<string, string>>, amount?: number): void;
  observe(name: string, seconds: number): void;
  run<T>(fields: TraceFields, work: () => Promise<T>): Promise<T>;
  event(message: string, fields: TraceFields): void;
}
export const NOOP_TELEMETRY: ApplicationTelemetry = {
  increment: () => {},
  observe: () => {},
  run: (_fields, work) => work(),
  event: () => {},
};
