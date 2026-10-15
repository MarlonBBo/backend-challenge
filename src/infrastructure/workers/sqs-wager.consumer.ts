import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.use-case';
import { WagerIdempotencyConflictError } from '../../application/wagering/process-wager-transaction.errors';
import { ExternalTransactionAlreadyExistsError } from '../../application/wagering/ports/wagering-unit-of-work';
import { InboxPayloadConflictError } from '../../application/wagering/ports/inbox-delivery';
import { sha256CanonicalJson } from '../../application/shared/canonical-json';
import { InvalidWagerMessageError, parseWagerRequest } from '../messaging/wager-request';
import {
  WAGER_QUEUE,
  WAGER_CONSUMER_NAME,
  SQS_CONSUMER_OPTIONS,
  type WagerQueue,
  type WagerQueueMessage,
  type SqsConsumerOptions,
} from '../messaging/wager-queue';

@Injectable()
export class SqsWagerConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private readonly receiving = new AbortController();
  private stopping = false;
  private running?: Promise<void>;

  constructor(
    @Inject(WAGER_QUEUE) private readonly queue: WagerQueue,
    @Inject(ProcessWagerTransactionUseCase)
    private readonly processor: Pick<ProcessWagerTransactionUseCase, 'execute'>,
    @Inject(SQS_CONSUMER_OPTIONS) private readonly options: SqsConsumerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.enabled) this.running = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.receiving.abort();
    await this.running;
    this.queue.close();
  }

  async handle(message: WagerQueueMessage): Promise<void> {
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (heartbeat !== undefined) return;
      heartbeat = this.queue
        .changeVisibility(message.receiptHandle, this.options.visibilitySeconds)
        .catch(() =>
          this.logger.warn({
            message: 'SQS visibility renewal failed',
            messageId: message.messageId,
          }),
        )
        .finally(() => {
          heartbeat = undefined;
        });
    }, this.options.heartbeatMs);
    const stopHeartbeat = async () => {
      clearInterval(timer);
      await heartbeat;
    };
    try {
      const request = parseWagerRequest(message.body);
      const result = await this.processor.execute(
        { ...request.data, correlationId: request.correlationId ?? request.messageId },
        {
          consumerName: WAGER_CONSUMER_NAME,
          messageId: request.messageId,
          payloadHash: sha256CanonicalJson(request.data),
        },
      );
      await stopHeartbeat();
      // A execução só é concluída após a confirmação (commit) 
      // da Unidade de Trabalho (Unit of Work), incluindo a caixa de entrada (inbox).
      await this.queue.acknowledge(message.receiptHandle);
      this.logger.log({
        message: 'SQS wagering message committed and acknowledged',
        correlationId: request.correlationId ?? request.messageId,
        messageId: request.messageId,
        transactionId: result.transactionId,
        walletId: request.data.walletId,
        providerId: request.data.providerId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
    } catch (error) {
      await stopHeartbeat();
      const permanent =
        error instanceof InvalidWagerMessageError ||
        error instanceof InboxPayloadConflictError ||
        error instanceof WagerIdempotencyConflictError ||
        error instanceof ExternalTransactionAlreadyExistsError;
      if (permanent) {
        // Não exclua a origem, a menos que o envio para a DLQ tenha sido bem-sucedido.
        await this.queue.deadLetter(message, error.code);
        await this.queue.acknowledge(message.receiptHandle);
        this.logger.warn({
          message: 'Permanent wagering message sent to DLQ',
          messageId: message.messageId,
          code: error.code,
        });
      } else {
        const delay = Math.min(
          this.options.retryBaseSeconds * 2 ** Math.min(message.receiveCount - 1, 20),
          this.options.retryMaxSeconds,
        );
        await this.queue.changeVisibility(message.receiptHandle, delay);
        this.logger.warn({
          message: 'Transient wagering failure; message will retry',
          messageId: message.messageId,
          receiveCount: message.receiveCount,
        });
      }
    } finally {
      await stopHeartbeat();
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const message = await this.queue.receive(this.receiving.signal);
        if (message === undefined) continue;
        if (this.stopping) {
          await this.queue.changeVisibility(message.receiptHandle, 0);
          break;
        }
        await this.handle(message);
      } catch {
        if (this.stopping) break;
        this.logger.warn('SQS receive or acknowledgement failed; retrying');
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
}
