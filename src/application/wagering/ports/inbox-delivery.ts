export interface InboxDelivery {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
}

export class InboxPayloadConflictError extends Error {
  readonly code = 'INBOX_PAYLOAD_CONFLICT';
  constructor() {
    super('The message identifier was reused with a different payload');
    this.name = 'InboxPayloadConflictError';
  }
}
