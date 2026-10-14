import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  Post,
} from '@nestjs/common';
import { z } from 'zod';

import {
  CreateWalletUseCase,
  type CreateWalletResult,
} from '../../application/wallet/create-wallet.use-case';
import { WalletAlreadyExistsError } from '../../application/wallet/ports/create-wallet-unit-of-work';

const createWalletSchema = z.object({
  playerId: z.uuid(),
  initialBalance: z.object({
    amount: z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/),
    currency: z.literal('BRL'),
  }),
});

@Controller('wallets')
export class WalletController {
  constructor(private readonly createWallet: CreateWalletUseCase) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<Readonly<CreateWalletResult>> {
    const parsed = createWalletSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVALID_PAYLOAD',
        message: 'Request body is invalid',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    try {
      return await this.createWallet.execute({
        ...parsed.data,
        correlationId: normalizeCorrelationId(correlationId),
      });
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      }

      throw error;
    }
  }
}

function normalizeCorrelationId(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0 || value.length > 255) {
    return randomUUID();
  }

  return value;
}
