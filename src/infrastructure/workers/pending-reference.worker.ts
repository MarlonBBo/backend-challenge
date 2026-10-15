import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';

import { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.use-case';
import type { Environment } from '../../config/environment';

export const REFERENCE_WORKER_OPTIONS = Symbol('REFERENCE_WORKER_OPTIONS');

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    @Inject(REFERENCE_WORKER_OPTIONS)
    private readonly options: Environment['references'],
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.enabled) {
      this.schedule();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.running = this.runBatch().finally(() => this.schedule());
    }, this.options.intervalMs);
  }

  private async runBatch(): Promise<void> {
    try {
      for (let index = 0; index < this.options.batchSize && !this.stopping; index += 1) {
        const result = await this.processTransaction.reprocessNextPending();
        if (result === undefined) break;
        this.logger.log({
          message: 'Pending reference attempted',
          transactionId: result.transactionId,
          status: result.status,
          failureCode: result.failureCode,
        });
      }
    } catch (error) {
      // A transação de banco de dados é revertida. O próximo ciclo a tenta novamente, de forma segura.
      this.logger.error(
        'Pending reference batch failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
