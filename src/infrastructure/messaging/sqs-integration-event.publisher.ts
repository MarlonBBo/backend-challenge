import { type SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { IntegrationEventPublisher } from '../../application/messaging/ports/integration-event-publisher';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export class SqsIntegrationEventPublisher implements IntegrationEventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );
  }

  close(): void {
    this.client.destroy();
  }
}
