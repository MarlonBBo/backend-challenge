import { z } from 'zod';
import type { LedgerPosition } from './ports/wallet-ledger-reader';

const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((value) => {
    const milliseconds = `${value.slice(0, 23)}Z`;
    const date = new Date(milliseconds);
    return (
      value.slice(0, 4) !== '0000' &&
      !Number.isNaN(date.getTime()) &&
      date.toISOString() === milliseconds
    );
  });

const cursorSchema = z
  .object({ version: z.literal(1), walletId: z.uuid(), createdAt: timestampSchema, id: z.uuid() })
  .strict();

export class InvalidLedgerCursorError extends Error {
  readonly code = 'INVALID_CURSOR';
  constructor() {
    super('Ledger cursor is invalid for this wallet');
    this.name = 'InvalidLedgerCursorError';
  }
}

export function encodeLedgerCursor(walletId: string, position: LedgerPosition): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      walletId: walletId.toLowerCase(),
      createdAt: position.createdAt,
      id: position.id,
    }),
  ).toString('base64url');
}

export function decodeLedgerCursor(value: string, walletId: string): LedgerPosition {
  if (value.length === 0 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new InvalidLedgerCursorError();
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new InvalidLedgerCursorError();
    const decoded: unknown = JSON.parse(bytes.toString('utf8'));
    const cursor = cursorSchema.parse(decoded);
    if (cursor.walletId.toLowerCase() !== walletId.toLowerCase())
      throw new InvalidLedgerCursorError();
    return { createdAt: cursor.createdAt, id: cursor.id };
  } catch {
    throw new InvalidLedgerCursorError();
  }
}
