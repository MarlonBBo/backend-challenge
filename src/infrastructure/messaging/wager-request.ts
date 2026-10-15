import { z } from 'zod';
import {
  processWagerTransactionSchema,
  idempotencyKeySchema,
} from '../../application/wagering/wager-transaction.schema';

const schema = z.object({
  messageId: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => value.trim() === value),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime({ offset: true }),
  correlationId: z.string().min(1).max(255).optional(),
  data: processWagerTransactionSchema.safeExtend({ idempotencyKey: idempotencyKeySchema }),
});

export class InvalidWagerMessageError extends Error {
  readonly code = 'INVALID_WAGER_MESSAGE';
  constructor() {
    super('Invalid wagering message envelope');
    this.name = 'InvalidWagerMessageError';
  }
}

export function parseWagerRequest(body: string): z.infer<typeof schema> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidWagerMessageError();
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new InvalidWagerMessageError();
  return result.data;
}
