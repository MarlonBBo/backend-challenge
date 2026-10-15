import {
  type SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { WagerQueue, WagerQueueMessage } from './wager-queue';

export class SqsWagerQueue implements WagerQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
    private readonly visibilitySeconds: number,
  ) {}

  async receive(signal: AbortSignal): Promise<WagerQueueMessage | undefined> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10,
        VisibilityTimeout: this.visibilitySeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: signal },
    );
    const message = result.Messages?.[0];
    if (message === undefined) return undefined;
    if (message.MessageId === undefined || message.ReceiptHandle === undefined)
      throw new Error('SQS returned an incomplete delivery');
    return {
      messageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      body: message.Body ?? '',
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
      groupId: message.Attributes?.MessageGroupId ?? message.MessageId,
    };
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async deadLetter(message: WagerQueueMessage, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.body || 'null',
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.messageId,
        MessageAttributes: {
          failureCode: { DataType: 'String', StringValue: reason },
          originalMessageId: { DataType: 'String', StringValue: message.messageId },
        },
      }),
    );
  }

  close(): void {
    this.client.destroy();
  }
}
