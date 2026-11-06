import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** Parses a request body with zod; 400 with field errors on failure. */
export function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Validation failed',
      errors: z.flattenError(result.error),
    });
  }
  return result.data;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
