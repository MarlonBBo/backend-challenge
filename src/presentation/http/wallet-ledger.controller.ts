import { BadRequestException, Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  GetWalletLedgerUseCase,
  InvalidLedgerPaginationError,
} from '../../application/wallet/get-wallet-ledger.use-case';
import { InvalidLedgerCursorError } from '../../application/wallet/ledger-cursor';
import { queryIdentifier, queryResponse } from './query-response';

const paginationSchema = z.object({
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .transform(Number)
    .pipe(z.number().int().max(100))
    .default(50),
  cursor: z.string().min(1).max(1024).optional(),
});

@Controller('wallets')
export class WalletLedgerController {
  constructor(@Inject(GetWalletLedgerUseCase) private readonly getLedger: GetWalletLedgerUseCase) {}

  @Get(':walletId/ledger')
  async get(@Param('walletId') walletId: string, @Query() query: unknown) {
    const id = queryIdentifier(walletId, 'walletId', true);
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'INVALID_PAGINATION',
        message: 'Invalid ledger pagination parameters',
      });
    try {
      return await queryResponse(() => this.getLedger.execute({ walletId: id, ...parsed.data }));
    } catch (error) {
      if (
        error instanceof InvalidLedgerCursorError ||
        error instanceof InvalidLedgerPaginationError
      )
        throw new BadRequestException({ code: error.code, message: error.message });
      throw error;
    }
  }
}
