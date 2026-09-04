import {
  adaptiveGranularity,
  bucketLabel,
  enumerateBuckets,
  type ResolvedRange,
} from './dates';
import {
  mostActiveDay,
  playedAtBounds,
  rankedEntityPage,
  timeBuckets,
  totalsAggregate,
  type BucketPoint,
  type QueryClient,
} from './aggregate';
import { normalizeName } from '@/lib/spotify/normalize';
import type { EntityKind, EntityScope, RankedEntity } from './scope';

export type { RankedEntity } from './scope';
export { rankOrder } from './scope';

export type DashboardData = {
  totals: {
    plays: number;
    estimatedDurationMs: number;
    uniqueTracks: number;
    uniqueAlbums: number;
    uniqueArtists: number;
  };
  topTrack: RankedEntity | null;
  topArtist: RankedEntity | null;
  topAlbum: RankedEntity | null;
  mostActiveDay: {
    date: string;
    plays: number;
    estimatedDurationMs: number;
  } | null;
  trend: Array<{ bucket: string; plays: number; estimatedDurationMs: number }>;
};

/**
 * Zero-fill a grouped series across every bucket in the range, so the shape
 * of the response does not depend on which buckets happened to have plays.
 */
export function fillSeries(
  points: Map<string, BucketPoint>,
  from: Date,
  to: Date,
  timezone: string,
  granularity: ReturnType<typeof adaptiveGranularity>,
  weekStartsOn: number,
): BucketPoint[] {
  return enumerateBuckets(from, to, timezone, granularity, weekStartsOn).map(
    (start) => {
      const label = bucketLabel(start, timezone, granularity);
      return (
        points.get(label) ?? { bucket: label, plays: 0, estimatedDurationMs: 0 }
      );
    },
  );
}

export async function dashboardData(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  entity?: EntityScope,
  weekStartsOn = 1,
): Promise<DashboardData> {
  const granularity = adaptiveGranularity(range.from, range.to);
  // Eight bounded aggregates instead of one unbounded materialisation: the
  // top-N queries return at most one row each and the trend at most one row
  // per bucket.
  const [totals, trendPoints, busiest, bounds, topTrack, topArtist, topAlbum] =
    await Promise.all([
      totalsAggregate(database, userId, range, entity),
      timeBuckets(database, userId, range, granularity, weekStartsOn, entity),
      mostActiveDay(database, userId, range, entity),
      range.from
        ? Promise.resolve({ first: null, last: null })
        : playedAtBounds(database, userId, range, entity),
      rankedEntityPage(database, userId, range, 'track', {
        limit: 1,
        ...(entity ? { entity } : {}),
      }),
      rankedEntityPage(database, userId, range, 'artist', {
        limit: 1,
        ...(entity ? { entity } : {}),
      }),
      rankedEntityPage(database, userId, range, 'album', {
        limit: 1,
        ...(entity ? { entity } : {}),
      }),
    ]);

  // ALL_TIME has no `from`, so the trend starts at the earliest retained play.
  const trendFrom = range.from ?? bounds.first;
  return {
    totals: {
      plays: totals.plays,
      estimatedDurationMs: totals.estimatedDurationMs,
      uniqueTracks: totals.uniqueTracks,
      uniqueAlbums: totals.uniqueAlbums,
      uniqueArtists: totals.uniqueArtists,
    },
    topTrack: topTrack.items[0] ?? null,
    topArtist: topArtist.items[0] ?? null,
    topAlbum: topAlbum.items[0] ?? null,
    mostActiveDay: busiest,
    trend: trendFrom
      ? fillSeries(
          trendPoints,
          trendFrom,
          range.to,
          range.timezone,
          granularity,
          weekStartsOn,
        )
      : [],
  };
}

/**
 * One page of ranked entities.
 *
 * Ranking, search, and pagination all happen in the query. The previous
 * implementation materialised every event, reduced it, and only then sliced
 * the result -- so the cost of page 1 was the cost of the entire history.
 */
export async function rankedEntities(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  kind: EntityKind,
  query: string | undefined,
  sort: 'plays' | 'estimatedDuration' | 'name',
  page: { limit: number; offset?: number } = { limit: 25 },
): Promise<{ items: RankedEntity[]; hasMore: boolean }> {
  return rankedEntityPage(database, userId, range, kind, {
    ...(query ? { search: normalizeName(query) } : {}),
    sort,
    limit: page.limit,
    ...(page.offset ? { offset: page.offset } : {}),
  });
}
