import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api/handler';
import { encodeCursor, decodeCursor } from '@/lib/api/pagination';
import { requestRange } from '@/lib/api/request-range';
import { historyQuerySchema } from '@/lib/api/history-query';
import { jsonResponse } from '@/lib/api/responses';
import { requireSession } from '@/lib/auth/request-session';
import { ApiRepository } from '@/lib/db/repositories/api';
import { database } from '@/lib/db/client';
import { assertOwnedEntityFilters } from '@/lib/api/ownership';

export async function GET(request: Request): Promise<NextResponse> {
  return apiHandler(request, async (requestId) => {
    const session = await requireSession(request);
    const { query, range } = await requestRange(
      session.userId,
      request.url,
      historyQuerySchema,
    );
    const repository = new ApiRepository(database);
    await assertOwnedEntityFilters(repository, session.userId, query);
    const rows = await repository.history(session.userId, {
      range,
      limit: query.limit,
      cursor: decodeCursor(query.cursor ?? null),
      ...(query.q ? { q: query.q } : {}),
      ...(query.artistId ? { artistId: query.artistId } : {}),
      ...(query.albumId ? { albumId: query.albumId } : {}),
      ...(query.trackId ? { trackId: query.trackId } : {}),
      ...(query.explicit === undefined ? {} : { explicit: query.explicit }),
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor =
      hasMore && last
        ? encodeCursor({ at: last.playedAt.toISOString(), id: last.id })
        : null;
    return jsonResponse(items, requestId, {
      timezone: range.timezone,
      range,
      nextCursor,
    });
  });
}
