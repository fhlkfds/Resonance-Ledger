import { z } from 'zod';
import { ApiRepository } from '@/lib/db/repositories/api';
import { database } from '@/lib/db/client';
import { normalizedRange, rangeFields } from './ranges';
import { parseSearchParams } from './query';

export const rangeQuerySchema = z.object(rangeFields).strict();

type RangeResult<T> = {
  query: T;
  settings: Awaited<ReturnType<ApiRepository['settings']>>;
  range: ReturnType<typeof normalizedRange>;
};

export async function requestRange(
  userId: string,
  requestUrl: string,
): Promise<RangeResult<z.infer<typeof rangeQuerySchema>>>;
export async function requestRange<T extends z.ZodObject>(
  userId: string,
  requestUrl: string,
  schema: T,
): Promise<RangeResult<z.infer<T>>>;
export async function requestRange(
  userId: string,
  requestUrl: string,
  schema: z.ZodObject = rangeQuerySchema,
): Promise<RangeResult<Record<string, unknown>>> {
  const query = parseSearchParams(requestUrl, schema);
  const settings = await new ApiRepository(database).settings(userId);
  return {
    query,
    settings,
    range: normalizedRange(
      query as {
        range: z.infer<typeof rangeQuerySchema>['range'];
        from?: string;
        to?: string;
        tz?: string;
      },
      settings,
    ),
  };
}
