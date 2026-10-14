import { describe, expect, it } from 'bun:test';

import {
  InboxMessage,
  InboxMessageAlreadyProcessedError,
  InvalidInboxMessageError,
} from '../../../../src/domain/messaging/inbox-message';

const receivedAt = new Date('2026-10-14T10:00:00.000Z');
const processedAt = new Date('2026-10-14T10:00:01.000Z');

function receive(): InboxMessage {
  return InboxMessage.receive({
    messageId: 'message-id',
    consumerName: 'wager-consumer',
    payloadHash: 'payload-hash',
    receivedAt,
  });
}

describe('InboxMessage', () => {
  it('receives an unprocessed message', () => {
    const message = receive();

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
    expect(message.matchesPayload('payload-hash')).toBe(true);
    expect(message.matchesPayload('different')).toBe(false);
  });

  it('marks a message as processed exactly once', () => {
    const message = receive();

    message.markProcessed(processedAt);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
    expect(() => message.markProcessed(processedAt)).toThrow(InboxMessageAlreadyProcessedError);
  });

  it.each([
    { messageId: '' },
    { consumerName: ' consumer' },
    { payloadHash: 'hash ' },
    { receivedAt: new Date('invalid') },
  ])('rejects invalid receive properties', (override) => {
    expect(() =>
      InboxMessage.receive({
        messageId: 'message-id',
        consumerName: 'consumer',
        payloadHash: 'hash',
        receivedAt,
        ...override,
      }),
    ).toThrow(InvalidInboxMessageError);
  });

  it('rehydrates processed state and protects timestamps', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'message-id',
      consumerName: 'consumer',
      payloadHash: 'hash',
      receivedAt,
      processedAt,
    });

    message.receivedAt.setUTCFullYear(2000);
    message.processedAt?.setUTCFullYear(2001);

    expect(message.receivedAt).toEqual(receivedAt);
    expect(message.processedAt).toEqual(processedAt);
  });
});
