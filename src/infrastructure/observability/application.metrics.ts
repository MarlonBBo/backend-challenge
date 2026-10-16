import { Inject, Injectable } from '@nestjs/common';
import type { ApplicationTelemetry, TraceFields } from '../../application/shared/telemetry';
import { TraceContext } from './trace-context';
import { JsonLogger } from './json.logger';

@Injectable()
export class ApplicationMetrics implements ApplicationTelemetry {
  private readonly values = new Map<string, number>();
  private readonly samples = new Map<string, { count: number; sum: number; buckets: number[] }>();
  private readonly bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  constructor(
    @Inject(TraceContext) private readonly trace: TraceContext,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}
  increment(name: string, labels: Readonly<Record<string, string>> = {}, amount = 1): void {
    const key = this.key(name, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }
  gauge(name: string, value: number): void {
    this.values.set(name, value);
  }
  observe(name: string, seconds: number): void {
    const sample = this.samples.get(name) ?? {
      count: 0,
      sum: 0,
      buckets: this.bounds.map(() => 0),
    };
    sample.count += 1;
    sample.sum += seconds;
    this.bounds.forEach((bound, index) => {
      if (seconds <= bound) sample.buckets[index]! += 1;
    });
    this.samples.set(name, sample);
  }
  run<T>(fields: TraceFields, work: () => Promise<T>): Promise<T> {
    return this.trace.run(fields, work);
  }
  event(message: string, fields: TraceFields): void {
    this.logger.warn({ message, ...fields });
  }
  render(): string {
    const lines = [...this.values]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key} ${value}`);
    for (const [name, sample] of this.samples) {
      this.bounds.forEach((bound, index) =>
        lines.push(`${name}_bucket{le="${bound}"} ${sample.buckets[index]}`),
      );
      lines.push(
        `${name}_bucket{le="+Inf"} ${sample.count}`,
        `${name}_count ${sample.count}`,
        `${name}_sum ${sample.sum}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
  private key(name: string, labels: Readonly<Record<string, string>>): string {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error('Invalid metric name');
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return entries.length === 0
      ? name
      : `${name}{${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}}`;
  }
}
