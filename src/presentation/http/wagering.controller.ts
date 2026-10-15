import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpStatus,
  NotFoundException,
  Post,
  Res,
} from '@nestjs/common';

import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionResult,
} from '../../application/wagering/process-wager-transaction.use-case';
import {
  WagerIdempotencyConflictError,
  WagerWalletNotFoundError,
} from '../../application/wagering/process-wager-transaction.errors';
import { ExternalTransactionAlreadyExistsError } from '../../application/wagering/ports/wagering-unit-of-work';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { processWagerTransactionSchema } from '../../application/wagering/wager-transaction.schema';

interface PassthroughHttpResponse {
  status(code: number): unknown;
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly processTransaction: ProcessWagerTransactionUseCase) {}

  @Post()
  async process(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: PassthroughHttpResponse,
  ): Promise<Readonly<ProcessWagerTransactionResult>> {
    const parsed = processWagerTransactionSchema.safeParse(body);
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

    if (
      idempotencyKey === undefined ||
      idempotencyKey.length === 0 ||
      idempotencyKey.trim() !== idempotencyKey ||
      idempotencyKey.length > 255
    ) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must be a non-empty canonical string up to 255 characters',
      });
    }

    try {
      const result = await this.processTransaction.execute({
        ...parsed.data,
        idempotencyKey,
        correlationId: normalizeCorrelationId(correlationId),
      });

      response.status(
        result.idempotentReplay
          ? HttpStatus.OK
          : result.status === WagerTransactionStatus.PendingReference
            ? HttpStatus.ACCEPTED
            : result.status === WagerTransactionStatus.Rejected
              ? HttpStatus.UNPROCESSABLE_ENTITY
              : HttpStatus.CREATED,
      );
      return result;
    } catch (error) {
      if (
        error instanceof WagerIdempotencyConflictError ||
        error instanceof ExternalTransactionAlreadyExistsError
      ) {
        throw new ConflictException({ code: error.code, message: error.message });
      }

      if (error instanceof WagerWalletNotFoundError) {
        throw new NotFoundException({ code: error.code, message: error.message });
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
