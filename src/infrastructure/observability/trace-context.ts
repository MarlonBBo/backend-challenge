import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { TraceFields } from '../../application/shared/telemetry';

@Injectable()
export class TraceContext {
  private readonly storage = new AsyncLocalStorage<TraceFields>();
  get fields(): TraceFields {
    return this.storage.getStore() ?? {};
  }
  run<T>(fields: TraceFields, work: () => T): T {
    return this.storage.run({ ...this.fields, ...fields }, work);
  }
}
