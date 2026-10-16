import { describe, expect, mock, test, spyOn } from 'bun:test';
import { ReconcileWalletUseCase } from '../../../src/application/wallet/reconcile-wallet.use-case';
import { NOOP_TELEMETRY } from '../../../src/application/shared/telemetry';
import { ResourceNotFoundError } from '../../../src/application/shared/resource-not-found.error';
import { HealthController } from '../../../src/presentation/http/health.controller';
import { TraceContext } from '../../../src/infrastructure/observability/trace-context';
import { JsonLogger } from '../../../src/infrastructure/observability/json.logger';
import { ApplicationMetrics } from '../../../src/infrastructure/observability/application.metrics';

describe('Reconciliation and observability', () => {
  test('reports a negative difference and signals a divergence without any write port', async () => {
    const increment = mock(() => {});
    const event = mock(() => {});
    const useCase = new ReconcileWalletUseCase(
      {
        read: () =>
          Promise.resolve({
            walletId: 'wallet',
            currency: 'BRL',
            storedBalance: '50.00',
            calculatedBalance: '100.00',
            difference: '-50.00',
            consistent: false,
            checkedEntries: 1,
            currencyMismatchEntries: 0,
            checkedAt: '2026-10-16T00:00:00.000Z',
          }),
      },
      { ...NOOP_TELEMETRY, increment, event },
    );
    const result = await useCase.execute('wallet');
    expect(result.difference).toEqual({ amount: '-50.00', currency: 'BRL' });
    expect(result.consistent).toBe(false);
    expect(increment).toHaveBeenCalledWith('wallet_reconciliation_divergences_total');
    expect(event).toHaveBeenCalledWith('Wallet reconciliation divergence detected', {
      walletId: 'wallet',
    });
  });
  test('a missing wallet is not treated as an empty wallet', () => {
    expect(
      new ReconcileWalletUseCase({ read: () => Promise.resolve(undefined) }).execute('missing'),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
  test('liveness does not access dependencies and readiness distinguishes failures', async () => {
    const probe = {
      database: mock(() => Promise.resolve()),
      sqs: mock(() => Promise.reject(new Error('queue down'))),
    };
    const controller = new HealthController(probe);
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(probe.database).not.toHaveBeenCalled();
    expect(controller.ready()).rejects.toMatchObject({ status: 503 });
    await Bun.sleep(1);
  });
  test('JSON logging includes context but omits financial payloads and secrets', () => {
    const trace = new TraceContext();
    const logger = new JsonLogger(trace);
    const lines: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        lines.push(chunk.toString());
        return true;
      },
    );
    try {
      trace.run({ correlationId: 'trace', walletId: 'wallet' }, () =>
        logger.log({
          message: 'processed',
          transactionId: 'tx',
          money: { amount: '999.99' },
          password: 'secret',
          payloadHash: 'hash',
        }),
      );
    } finally {
      write.mockRestore();
    }
    expect(lines).toHaveLength(1);
    const record: unknown = JSON.parse(lines[0]!);
    expect(record).toMatchObject({
      level: 'info',
      correlationId: 'trace',
      walletId: 'wallet',
      transactionId: 'tx',
    });
    expect(lines[0]).not.toContain('999.99');
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toContain('payloadHash');
  });
  test('metrics expose counters, gauges and cumulative histogram buckets', () => {
    const trace = new TraceContext();
    const metrics = new ApplicationMetrics(trace, new JsonLogger(trace));
    metrics.increment('wager_transactions_total', { status: 'PROCESSED' });
    metrics.gauge('outbox_pending_messages', 2);
    metrics.observe('wager_processing_duration_seconds', 0.02);
    expect(metrics.render()).toContain('wager_transactions_total{status="PROCESSED"} 1');
    expect(metrics.render()).toContain('outbox_pending_messages 2');
    expect(metrics.render()).toContain('wager_processing_duration_seconds_bucket{le="0.025"} 1');
    expect(metrics.render()).toContain('wager_processing_duration_seconds_count 1');
  });
});
