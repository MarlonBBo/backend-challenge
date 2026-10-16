export const READINESS_PROBE = Symbol('READINESS_PROBE');
export interface ReadinessProbe {
  database(): Promise<void>;
  sqs(): Promise<void>;
}
