export interface ReceiveInboxMessageProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxMessageProps {
  readonly processedAt?: Date;
}

export class InvalidInboxMessageError extends Error {
  readonly code = 'INVALID_INBOX_MESSAGE';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidInboxMessageError';
  }
}

export class InboxMessageAlreadyProcessedError extends Error {
  readonly code = 'INBOX_MESSAGE_ALREADY_PROCESSED';

  constructor() {
    super('Inbox message is already processed');
    this.name = 'InboxMessageAlreadyProcessedError';
  }
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    private readonly _receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxMessageProps): InboxMessage {
    InboxMessage.assertNonEmpty(props.messageId, 'messageId');
    InboxMessage.assertNonEmpty(props.consumerName, 'consumerName');
    InboxMessage.assertNonEmpty(props.payloadHash, 'payloadHash');
    InboxMessage.assertValidTimestamp(props.receivedAt);

    return InboxMessage.build(props);
  }

  /** Reconstrói o estado persistido confiável sem reexecutar as regras de transição. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return InboxMessage.build(state);
  }

  get receivedAt(): Date {
    return new Date(this._receivedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : new Date(this._processedAt);
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InboxMessageAlreadyProcessedError();
    }

    InboxMessage.assertValidTimestamp(at);
    this._processedAt = new Date(at);
  }

  private static build(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt === undefined ? undefined : new Date(state.processedAt),
    );
  }

  private static assertNonEmpty(value: string, field: string): void {
    if (value.length === 0 || value.trim() !== value) {
      throw new InvalidInboxMessageError(`${field} must be a non-empty canonical string`);
    }
  }

  private static assertValidTimestamp(timestamp: Date): void {
    if (Number.isNaN(timestamp.getTime())) {
      throw new InvalidInboxMessageError('Inbox timestamp must be a valid date');
    }
  }
}
