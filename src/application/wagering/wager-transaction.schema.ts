import { z } from 'zod';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction';

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value);

export const processWagerTransactionSchema = z
  .object({
    providerId: z.string().trim().min(1).max(100),
    externalTransactionId: z.string().trim().min(1).max(255),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: z.string().trim().min(1).max(255),
    gameId: z.string().trim().min(1).max(255),
    kind: z.enum([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]),
    money: z.object({
      amount: z
        .string()
        .regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/)
        .refine((value) => value !== '0.00', 'Amount must be positive'),
      currency: z.literal('BRL'),
    }),
    referenceExternalTransactionId: z.string().trim().min(1).max(255).optional(),
  })
  .superRefine((value, context) => {
    const requiresReference =
      value.kind === WagerTransactionKind.Refund || value.kind === WagerTransactionKind.Rollback;
    const forbidsReference =
      value.kind === WagerTransactionKind.Bet || value.kind === WagerTransactionKind.Loss;
    if (requiresReference && value.referenceExternalTransactionId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: `${value.kind} requires a reference`,
      });
    }
    if (forbidsReference && value.referenceExternalTransactionId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: `${value.kind} cannot have a reference`,
      });
    }
  });
