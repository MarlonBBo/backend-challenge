import type { OutboxMessage } from '../../../domain/messaging/outbox-message';

export const INTEGRATION_EVENT_PUBLISHER = Symbol('INTEGRATION_EVENT_PUBLISHER');

export interface IntegrationEventPublisher {
  publish(message: OutboxMessage): Promise<void>;
  close(): void;
}
