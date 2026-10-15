export const WAGER_QUEUE = Symbol('WAGER_QUEUE');
export const SQS_CONSUMER_OPTIONS = Symbol('SQS_CONSUMER_OPTIONS');
export const WAGER_CONSUMER_NAME = 'wager-transactions-v1';

export interface WagerQueueMessage {
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly body: string;
  readonly receiveCount: number;
  readonly groupId: string;
}

export interface WagerQueue {
  receive(signal: AbortSignal): Promise<WagerQueueMessage | undefined>;
  acknowledge(receiptHandle: string): Promise<void>;
  changeVisibility(receiptHandle: string, seconds: number): Promise<void>;
  deadLetter(message: WagerQueueMessage, reason: string): Promise<void>;
  close(): void;
}

export interface SqsConsumerOptions {
  readonly enabled: boolean;
  readonly visibilitySeconds: number;
  readonly heartbeatMs: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
}
