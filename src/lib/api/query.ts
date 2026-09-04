import { z } from 'zod';
import { ProblemError } from './errors';

export function parseSearchParams<T extends z.ZodType>(
  url: string,
  schema: T,
): z.infer<T> {
  const parameters = Object.fromEntries(new URL(url).searchParams.entries());
  const result = schema.safeParse(parameters);
  if (!result.success) {
    throw new ProblemError(
      400,
      'INVALID_QUERY',
      'Query parameters are invalid',
    );
  }
  return result.data;
}

export const pageFields = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1024).optional(),
};
