import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { ResourceNotFoundError } from '../../application/shared/resource-not-found.error';

export function queryIdentifier(value: string, field: string, uuid = false): string {
  const schema = uuid
    ? z.uuid()
    : z
        .string()
        .min(1)
        .max(field === 'providerId' ? 100 : 255)
        .refine((input) => input.trim() === input);
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new BadRequestException({
      code: 'INVALID_PATH_PARAMETER',
      message: `Invalid ${field}`,
      field,
    });
  return parsed.data;
}

export async function queryResponse<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ResourceNotFoundError)
      throw new NotFoundException({ code: error.code, message: error.message });
    throw error;
  }
}
