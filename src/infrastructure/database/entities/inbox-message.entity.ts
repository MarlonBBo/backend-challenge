import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({ fieldName: 'consumer_name', type: 'string', length: 100 })
  consumerName!: string;

  @PrimaryKey({ fieldName: 'message_id', type: 'string', length: 255 })
  messageId!: string;

  @Property({ fieldName: 'payload_hash', columnType: 'char(64)' })
  payloadHash!: string;

  @Property({ fieldName: 'received_at', columnType: 'timestamptz' })
  receivedAt!: Date;

  @Property({ fieldName: 'processed_at', columnType: 'timestamptz', nullable: true })
  processedAt: Date | null = null;
}
