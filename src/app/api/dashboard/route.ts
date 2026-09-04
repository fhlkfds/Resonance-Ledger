import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api/handler';
import { jsonResponse } from '@/lib/api/responses';
import { requireSession } from '@/lib/auth/request-session';
import { requestRange } from '@/lib/api/request-range';
import { database } from '@/lib/db/client';
import { dashboardData } from '@/lib/stats/queries';
import { priorPeriod } from '@/lib/stats/dates';

export async function GET(request: Request): Promise<NextResponse> {
  return apiHandler(request, async (requestId) => {
    const session = await requireSession(request);
    const { range, settings } = await requestRange(session.userId, request.url);
    const previous = priorPeriod(range);
    const [dashboard, prior, recent, earliestRetainedAt] =
      await database.$transaction(
        async (transaction) =>
          Promise.all([
            dashboardData(
              transaction,
              session.userId,
              range,
              undefined,
              settings.weekStartsOn,
            ),
            previous
              ? dashboardData(
                  transaction,
                  session.userId,
                  {
                    preset: 'CUSTOM',
                    from: previous.from,
                    to: previous.to,
                    timezone: range.timezone,
                  },
                  undefined,
                  settings.weekStartsOn,
                )
              : null,
            transaction.listeningHistory.findMany({
              where: { spotifyAccount: { userId: session.userId } },
              orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
              take: 10,
              include: {
                track: {
                  include: {
                    album: {
                      select: { id: true, name: true, artworkUrl: true },
                    },
                    artists: {
                      orderBy: { position: 'asc' },
                      include: { artist: { select: { id: true, name: true } } },
                    },
                  },
                },
              },
            }),
            transaction.listeningHistory.findFirst({
              where: { spotifyAccount: { userId: session.userId } },
              orderBy: [{ playedAt: 'asc' }, { id: 'asc' }],
              select: { playedAt: true },
            }),
          ]),
        { isolationLevel: 'RepeatableRead' },
      );
    const comparison = prior
      ? {
          plays: dashboard.totals.plays - prior.totals.plays,
          estimatedDurationMs:
            dashboard.totals.estimatedDurationMs -
            prior.totals.estimatedDurationMs,
        }
      : null;
    return jsonResponse({ ...dashboard, recent, comparison }, requestId, {
      timezone: range.timezone,
      range,
      earliestRetainedAt: earliestRetainedAt?.playedAt ?? null,
    });
  });
}
