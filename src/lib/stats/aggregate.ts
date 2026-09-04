import { Prisma, type PrismaClient } from '@prisma/client';
import type { Granularity, ResolvedRange } from './dates';
import {
  scopedEventsCte,
  type EntityKind,
  type EntityScope,
  type RankedEntity,
} from './scope';

/**
 * SQL aggregation for every statistics surface.
 *
 * Before this module each surface loaded the user's whole matching history
 * into Node -- no `take`, no aggregation -- and reduced it in memory. At the
 * spec's own one-million-event scale a single authenticated request could
 * exhaust the heap, repeatedly. Every query here returns grouped rows only:
 * a bounded handful for the calendar dimensions (24 hours, 7 weekdays, 168
 * hour-weekday cells, 12 months), and LIMIT-ed rows for rankings. Nothing
 * per-event crosses the boundary.
 *
 * Tenant scoping is entirely in scopedEventsCte; nothing here reaches
 * listening_history directly.
 */

export type QueryClient = PrismaClient | Prisma.TransactionClient;

export type BucketPoint = {
  bucket: string;
  plays: number;
  estimatedDurationMs: number;
};

/** int8 arrives as BigInt over the wire. */
const num = (value: unknown): number =>
  typeof value === 'bigint' ? Number(value) : Number(value ?? 0);

/** The event timestamp as local wall-clock time in the user's timezone. */
function localTimestamp(timezone: string): Prisma.Sql {
  return Prisma.sql`(scoped.played_at AT TIME ZONE ${timezone}::text)`;
}

/**
 * Bucket start in the user's local calendar. `date_trunc('week', ...)` is ISO
 * (Monday-based), so an arbitrary week start is handled by shifting into and
 * back out of Monday-based weeks.
 */
function bucketStart(
  timezone: string,
  granularity: Granularity,
  weekStartsOn: number,
): Prisma.Sql {
  const local = localTimestamp(timezone);
  switch (granularity) {
    case 'hour':
      return Prisma.sql`date_trunc('hour', ${local})`;
    case 'day':
      return Prisma.sql`date_trunc('day', ${local})`;
    case 'week': {
      const shift = (1 - weekStartsOn + 7) % 7;
      return Prisma.sql`(date_trunc('week', ${local} + make_interval(days => ${shift}::int)) - make_interval(days => ${shift}::int))`;
    }
    case 'month':
      return Prisma.sql`date_trunc('month', ${local})`;
    case 'year':
      return Prisma.sql`date_trunc('year', ${local})`;
  }
}

/** Mirrors bucketLabel() in ./dates.ts, evaluated by PostgreSQL instead. */
const LABEL_FORMAT: Record<Granularity, string> = {
  hour: 'YYYY-MM-DD"T"HH24',
  day: 'YYYY-MM-DD',
  week: 'YYYY-MM-DD',
  month: 'YYYY-MM',
  year: 'YYYY',
};

type LabelledRow = { label: string | null; plays: bigint; duration: bigint };

function pointsByLabel(rows: LabelledRow[]): Map<string, BucketPoint> {
  const points = new Map<string, BucketPoint>();
  for (const row of rows) {
    if (row.label === null) continue;
    points.set(row.label, {
      bucket: row.label,
      plays: num(row.plays),
      estimatedDurationMs: num(row.duration),
    });
  }
  return points;
}

export type Totals = {
  plays: number;
  estimatedDurationMs: number;
  uniqueTracks: number;
  uniqueAlbums: number;
  uniqueArtists: number;
  artistPlayCredits: number;
};

/**
 * Totals, distinct counts, and the artist credit count. Two queries because
 * joining track_artists multiplies rows by the credit count, which would
 * corrupt the play and duration sums.
 */
export async function totalsAggregate(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  entity?: EntityScope,
): Promise<Totals> {
  const scoped = scopedEventsCte(userId, range, entity);
  const [base, credits] = await Promise.all([
    database.$queryRaw<
      Array<{
        plays: bigint;
        duration: bigint;
        unique_tracks: bigint;
        unique_albums: bigint;
      }>
    >(Prisma.sql`
      WITH ${scoped}
      SELECT
        COUNT(*)::bigint AS plays,
        COALESCE(SUM(scoped.estimated_duration_ms), 0)::bigint AS duration,
        COUNT(DISTINCT scoped.track_id)::bigint AS unique_tracks,
        COUNT(DISTINCT t.album_id)::bigint AS unique_albums
      FROM scoped
      LEFT JOIN tracks t ON t.id = scoped.track_id
    `),
    database.$queryRaw<Array<{ unique_artists: bigint; credits: bigint }>>(
      Prisma.sql`
      WITH ${scoped}
      SELECT
        COUNT(DISTINCT ta.artist_id)::bigint AS unique_artists,
        COUNT(*)::bigint AS credits
      FROM scoped
      JOIN track_artists ta ON ta.track_id = scoped.track_id
    `,
    ),
  ]);
  return {
    plays: num(base[0]?.plays),
    estimatedDurationMs: num(base[0]?.duration),
    uniqueTracks: num(base[0]?.unique_tracks),
    uniqueAlbums: num(base[0]?.unique_albums),
    uniqueArtists: num(credits[0]?.unique_artists),
    artistPlayCredits: num(credits[0]?.credits),
  };
}

/** Grouped time-series buckets, keyed by the same labels bucketLabel emits. */
export async function timeBuckets(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  granularity: Granularity,
  weekStartsOn: number,
  entity?: EntityScope,
): Promise<Map<string, BucketPoint>> {
  const scoped = scopedEventsCte(userId, range, entity);
  const start = bucketStart(range.timezone, granularity, weekStartsOn);
  const format = Prisma.raw(`'${LABEL_FORMAT[granularity]}'`);
  const rows = await database.$queryRaw<LabelledRow[]>(Prisma.sql`
    WITH ${scoped}
    SELECT
      to_char(${start}, ${format}) AS label,
      COUNT(*)::bigint AS plays,
      COALESCE(SUM(scoped.estimated_duration_ms), 0)::bigint AS duration
    FROM scoped
    GROUP BY 1
  `);
  return pointsByLabel(rows);
}

/**
 * One grouped row per calendar part. `part` is a closed enum, never user
 * input, and every result set here is at most 168 rows.
 */
export async function calendarBuckets(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  part: 'hour' | 'weekday' | 'month' | 'weekday_hour' | 'day',
  entity?: EntityScope,
): Promise<Map<string, BucketPoint>> {
  const scoped = scopedEventsCte(userId, range, entity);
  const local = localTimestamp(range.timezone);
  // Numeric keys, never localised names: to_char('Day') follows the server's
  // lc_time, so the caller maps 0..6 and 1..12 to names itself -- the same
  // way the previous in-Node reduction used ZonedParts.weekday and .month.
  const key = {
    hour: Prisma.sql`to_char(${local}, 'HH24')`,
    weekday: Prisma.sql`EXTRACT(DOW FROM ${local})::int::text`,
    month: Prisma.sql`EXTRACT(MONTH FROM ${local})::int::text`,
    weekday_hour: Prisma.sql`EXTRACT(DOW FROM ${local})::int::text || ':' || EXTRACT(HOUR FROM ${local})::int::text`,
    day: Prisma.sql`to_char(${local}, 'YYYY-MM-DD')`,
  }[part];
  const rows = await database.$queryRaw<LabelledRow[]>(Prisma.sql`
    WITH ${scoped}
    SELECT
      ${key} AS label,
      COUNT(*)::bigint AS plays,
      COALESCE(SUM(scoped.estimated_duration_ms), 0)::bigint AS duration
    FROM scoped
    GROUP BY 1
  `);
  return pointsByLabel(rows);
}

/** The single busiest local day, decided entirely in SQL. */
export async function mostActiveDay(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  entity?: EntityScope,
): Promise<{
  date: string;
  plays: number;
  estimatedDurationMs: number;
} | null> {
  const scoped = scopedEventsCte(userId, range, entity);
  const local = localTimestamp(range.timezone);
  const rows = await database.$queryRaw<LabelledRow[]>(Prisma.sql`
    WITH ${scoped}
    SELECT
      to_char(${local}, 'YYYY-MM-DD') AS label,
      COUNT(*)::bigint AS plays,
      COALESCE(SUM(scoped.estimated_duration_ms), 0)::bigint AS duration
    FROM scoped
    GROUP BY 1
    ORDER BY plays DESC, duration DESC, label DESC
    LIMIT 1
  `);
  const row = rows[0];
  if (!row?.label) return null;
  return {
    date: row.label,
    plays: num(row.plays),
    estimatedDurationMs: num(row.duration),
  };
}

/** Per-(year, MM-DD) counts for the year-over-year overlay. */
export async function yearDayBuckets(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  entity?: EntityScope,
): Promise<Map<number, Map<string, BucketPoint>>> {
  const scoped = scopedEventsCte(userId, range, entity);
  const local = localTimestamp(range.timezone);
  const rows = await database.$queryRaw<
    Array<{ year: number; label: string; plays: bigint; duration: bigint }>
  >(Prisma.sql`
    WITH ${scoped}
    SELECT
      EXTRACT(YEAR FROM ${local})::int AS year,
      to_char(${local}, 'MM-DD') AS label,
      COUNT(*)::bigint AS plays,
      COALESCE(SUM(scoped.estimated_duration_ms), 0)::bigint AS duration
    FROM scoped
    GROUP BY 1, 2
  `);
  const years = new Map<number, Map<string, BucketPoint>>();
  for (const row of rows) {
    const year = years.get(row.year) ?? new Map<string, BucketPoint>();
    year.set(row.label, {
      bucket: row.label,
      plays: num(row.plays),
      estimatedDurationMs: num(row.duration),
    });
    years.set(row.year, year);
  }
  return years;
}

const ENTITY_JOIN: Record<EntityKind, Prisma.Sql> = {
  track: Prisma.sql`JOIN tracks e ON e.id = scoped.track_id`,
  album: Prisma.sql`JOIN tracks rank_t ON rank_t.id = scoped.track_id
                    JOIN albums e ON e.id = rank_t.album_id`,
  // One credit per credited artist, so a collaboration counts for each.
  artist: Prisma.sql`JOIN track_artists ta ON ta.track_id = scoped.track_id
                     JOIN artists e ON e.id = ta.artist_id`,
};

const RANK_ORDER: Record<'plays' | 'estimatedDuration' | 'name', Prisma.Sql> = {
  plays: Prisma.sql`plays DESC, duration DESC, normalized_name ASC, id ASC`,
  estimatedDuration: Prisma.sql`duration DESC, plays DESC, normalized_name ASC, id ASC`,
  name: Prisma.sql`normalized_name ASC, id ASC`,
};

/**
 * Ranked entities, grouped, ordered, and paginated in the query.
 *
 * One extra row beyond `limit` is fetched purely as a has-more signal, which
 * avoids a second counting pass over the whole group set.
 */
export async function rankedEntityPage(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  kind: EntityKind,
  options: {
    search?: string | undefined;
    sort?: 'plays' | 'estimatedDuration' | 'name';
    limit: number;
    offset?: number;
    entity?: EntityScope;
  },
): Promise<{ items: RankedEntity[]; hasMore: boolean }> {
  const scoped = scopedEventsCte(userId, range, options.entity);
  const limit = Math.max(1, Math.floor(options.limit));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const search = options.search
    ? Prisma.sql`WHERE normalized_name LIKE '%' || ${options.search} || '%'`
    : Prisma.empty;
  const rows = await database.$queryRaw<
    Array<{
      id: string;
      name: string;
      normalized_name: string;
      plays: bigint;
      duration: bigint;
    }>
  >(Prisma.sql`
    WITH ${scoped},
    grouped AS (
      SELECT
        e.id AS id,
        e.name AS name,
        e.normalized_name AS normalized_name,
        COUNT(*)::bigint AS plays,
        COALESCE(SUM(scoped.estimated_duration_ms), 0)::bigint AS duration
      FROM scoped
      ${ENTITY_JOIN[kind]}
      GROUP BY e.id, e.name, e.normalized_name
    )
    SELECT id, name, normalized_name, plays, duration
    FROM grouped
    ${search}
    ORDER BY ${RANK_ORDER[options.sort ?? 'plays']}
    LIMIT ${limit + 1}
    OFFSET ${offset}
  `);
  return {
    items: rows.slice(0, limit).map((row) => ({
      id: row.id,
      name: row.name,
      normalizedName: row.normalized_name,
      plays: num(row.plays),
      estimatedDurationMs: num(row.duration),
    })),
    hasMore: rows.length > limit,
  };
}

/** Total plays credited across all entities of a kind: the share denominator. */
export async function distributionDenominator(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  kind: EntityKind,
  entity?: EntityScope,
): Promise<number> {
  const scoped = scopedEventsCte(userId, range, entity);
  const rows = await database.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
    WITH ${scoped}
    SELECT COUNT(*)::bigint AS total
    FROM scoped
    ${ENTITY_JOIN[kind]}
  `);
  return num(rows[0]?.total);
}

/** 1-based rank of one entity within its kind, computed in the query. */
export async function entityRank(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  kind: EntityKind,
  id: string,
): Promise<number | null> {
  const scoped = scopedEventsCte(userId, range);
  const rows = await database.$queryRaw<Array<{ position: bigint }>>(
    Prisma.sql`
    WITH ${scoped},
    grouped AS (
      SELECT
        e.id AS id,
        e.normalized_name AS normalized_name,
        COUNT(*)::bigint AS plays,
        COALESCE(SUM(scoped.estimated_duration_ms), 0)::bigint AS duration
      FROM scoped
      ${ENTITY_JOIN[kind]}
      GROUP BY e.id, e.normalized_name
    ),
    ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        ORDER BY plays DESC, duration DESC, normalized_name ASC, id ASC
      )::bigint AS position
      FROM grouped
    )
    SELECT position FROM ranked WHERE id = ${id}::uuid
  `,
  );
  const position = rows[0]?.position;
  return position === undefined ? null : num(position);
}

/** Earliest and latest retained play in scope, without loading any events. */
export async function playedAtBounds(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  entity?: EntityScope,
): Promise<{ first: Date | null; last: Date | null }> {
  const scoped = scopedEventsCte(userId, range, entity);
  const rows = await database.$queryRaw<
    Array<{ first: Date | null; last: Date | null }>
  >(Prisma.sql`
    WITH ${scoped}
    SELECT MIN(scoped.played_at) AS first, MAX(scoped.played_at) AS last
    FROM scoped
  `);
  return { first: rows[0]?.first ?? null, last: rows[0]?.last ?? null };
}
