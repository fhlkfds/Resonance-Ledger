import { z } from 'zod';
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api/handler';
import { decodeCursor } from '@/lib/api/pagination';
import { requestRange } from '@/lib/api/request-range';
import { rangeFields } from '@/lib/api/ranges';
import { requireSession } from '@/lib/auth/request-session';
import { ApiRepository } from '@/lib/db/repositories/api';
import { database } from '@/lib/db/client';
import { assertOwnedEntityFilters } from '@/lib/api/ownership';
import { dashboardData } from '@/lib/stats/queries';
import { enforceRateLimit } from '@/lib/api/rate-limit';

const schema = z
  .object({
    ...rangeFields,
    type: z.enum(['history', 'stats']),
    format: z.enum(['csv', 'json']),
    q: z.string().trim().min(1).max(200).optional(),
    artistId: z.uuid().optional(),
    albumId: z.uuid().optional(),
    trackId: z.uuid().optional(),
    explicit: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .strict();

export function neutralizeCsvFormula(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number | boolean): string {
  const safe = neutralizeCsvFormula(String(value));
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function GET(request: Request): Promise<NextResponse> {
  return apiHandler(request, async (requestId) => {
    const session = await requireSession(request);
    await enforceRateLimit(database, `export:${session.userId}`, 3, 600);
    const { query, range, settings } = await requestRange(
      session.userId,
      request.url,
      schema,
    );
    const repository = new ApiRepository(database);
    await assertOwnedEntityFilters(repository, session.userId, query);
    if (query.type === 'stats') {
      const statistics = await dashboardData(
        database,
        session.userId,
        range,
        undefined,
        settings.weekStartsOn,
      );
      const body =
        query.format === 'json'
          ? JSON.stringify({
              data: statistics,
              meta: {
                timezone: range.timezone,
                metric: 'Estimated listening time',
                caveat: 'Spotify provides no actual played milliseconds.',
              },
            })
          : `metric,value\n${Object.entries(statistics.totals)
              .map(([metric, value]) => `${csvCell(metric)},${csvCell(value)}`)
              .join('\n')}\n`;
      return new NextResponse(body, {
        headers: {
          'Content-Type':
            query.format === 'csv'
              ? 'text/csv; charset=utf-8'
              : 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="resonance-ledger-stats.${query.format}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Request-ID': requestId,
        },
      });
    }
    const encoder = new TextEncoder();
    let cursor: string | null = null;
    let started = false;
    let finished = false;
    let jsonFirst = true;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (finished) return;
        if (!started) {
          started = true;
          const header =
            query.format === 'csv'
              ? `# timezone=${range.timezone}; metric=Estimated listening time; Spotify provides no actual played milliseconds.\nplayedAt,track,artists,album,estimatedDurationMs,explicit\n`
              : `{"meta":{"timezone":${JSON.stringify(range.timezone)},"metric":"Estimated listening time","caveat":"Spotify provides no actual played milliseconds."},"data":[`;
          controller.enqueue(encoder.encode(header));
        }
        const rows = await repository.history(session.userId, {
          range,
          limit: 100,
          cursor: decodeCursor(cursor),
          ...(query.q ? { q: query.q } : {}),
          ...(query.artistId ? { artistId: query.artistId } : {}),
          ...(query.albumId ? { albumId: query.albumId } : {}),
          ...(query.trackId ? { trackId: query.trackId } : {}),
          ...(query.explicit === undefined ? {} : { explicit: query.explicit }),
        });
        const items = rows.slice(0, 100);
        for (const event of items) {
          const record = {
            playedAt: event.playedAt.toISOString(),
            track: event.track.name,
            artists: event.track.artists
              .map(({ artist }) => artist.name)
              .join('; '),
            album: event.track.album?.name ?? '',
            estimatedDurationMs: event.estimatedDurationMs,
            explicit: event.track.explicit,
          };
          if (query.format === 'csv') {
            controller.enqueue(
              encoder.encode(
                `${Object.values(record).map(csvCell).join(',')}\n`,
              ),
            );
          } else {
            controller.enqueue(
              encoder.encode(
                `${jsonFirst ? '' : ','}${JSON.stringify(record)}`,
              ),
            );
            jsonFirst = false;
          }
        }
        const hasMore = rows.length > 100;
        const last = items.at(-1);
        cursor =
          hasMore && last
            ? Buffer.from(
                JSON.stringify({
                  at: last.playedAt.toISOString(),
                  id: last.id,
                }),
              ).toString('base64url')
            : null;
        if (!hasMore) {
          if (query.format === 'json') controller.enqueue(encoder.encode(']}'));
          controller.close();
          finished = true;
        }
      },
    });
    return new NextResponse(stream, {
      headers: {
        'Content-Type':
          query.format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="resonance-ledger.${query.format}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Request-ID': requestId,
      },
    });
  });
}
