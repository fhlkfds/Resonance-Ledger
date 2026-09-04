import { z } from 'zod';
import { ProblemError } from './errors';
import { decodeOffsetCursor, encodeOffsetCursor } from './pagination';
import { apiHandler } from './handler';
import { pageFields } from './query';
import { requestRange } from './request-range';
import { rangeFields } from './ranges';
import { jsonResponse } from './responses';
import { requireSession } from '@/lib/auth/request-session';
import { database } from '@/lib/db/client';
import { rankedEntities } from '@/lib/stats/queries';
import { entityDetailData } from '@/lib/stats/entity-details';

export const entityListSchema = z
  .object({
    ...rangeFields,
    ...pageFields,
    q: z.string().trim().min(1).max(200).optional(),
    sort: z.enum(['plays', 'estimatedDuration', 'name']).default('plays'),
  })
  .strict();

export function entityListHandler(
  request: Request,
  kind: 'track' | 'artist' | 'album',
) {
  return apiHandler(request, async (requestId) => {
    const session = await requireSession(request);
    const { query, range } = await requestRange(
      session.userId,
      request.url,
      entityListSchema,
    );
    const offset = decodeOffsetCursor(query.cursor);
    // Ranking and pagination happen in the query; nothing beyond this page is
    // ever loaded.
    const { items, hasMore } = await rankedEntities(
      database,
      session.userId,
      range,
      kind,
      query.q,
      query.sort,
      { limit: query.limit, offset },
    );
    const nextCursor = hasMore
      ? encodeOffsetCursor(offset + query.limit)
      : null;
    return jsonResponse(items, requestId, {
      timezone: range.timezone,
      range,
      nextCursor,
    });
  });
}

export function entityDetailHandler(
  request: Request,
  kind: 'track' | 'artist' | 'album',
  id: string,
) {
  return apiHandler(request, async (requestId) => {
    const parsedId = z.uuid().safeParse(id);
    if (!parsedId.success)
      throw new ProblemError(400, 'INVALID_ID', 'Entity ID is invalid');
    const session = await requireSession(request);
    const { range, settings } = await requestRange(session.userId, request.url);
    const detail = await entityDetailData(
      database,
      session.userId,
      range,
      settings.weekStartsOn,
      kind,
      id,
    );
    if (!detail)
      throw new ProblemError(404, 'ENTITY_NOT_FOUND', 'Entity not found');
    return jsonResponse(detail, requestId, {
      timezone: range.timezone,
      range,
    });
  });
}
