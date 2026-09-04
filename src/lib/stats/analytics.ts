import type { PrismaClient } from '@prisma/client';
import {
  adaptiveGranularity,
  zonedPartsToUtc,
  enumerateBuckets,
  bucketLabel,
  type Granularity,
  type ResolvedRange,
} from './dates';
import {
  calendarBuckets,
  distributionDenominator,
  playedAtBounds,
  rankedEntityPage,
  timeBuckets,
  totalsAggregate,
  yearDayBuckets,
  type BucketPoint,
} from './aggregate';
import { fillSeries } from './queries';
import type { EntityScope, RankedEntity } from './scope';

export { rankOrder } from './scope';

type AnalyticsOptions = {
  granularity?: Granularity;
  rankingLimit?: number;
  distributionLimit?: number;
  years?: number[];
  entity?: EntityScope;
};

const weekdayNames = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const emptyPoint = (bucket: string): BucketPoint => ({
  bucket,
  plays: 0,
  estimatedDurationMs: 0,
});

/**
 * Build the top-N slice plus an "Other" remainder.
 *
 * The denominator is every credited play in scope, counted in SQL, so the
 * shares stay correct without ranking every entity in memory.
 */
function distribution(top: RankedEntity[], denominator: number, limit: number) {
  const items = top.slice(0, limit).map((item) => ({
    id: item.id as string | null,
    name: item.name,
    plays: item.plays,
    share: denominator ? item.plays / denominator : 0,
  }));
  const used = items.reduce((sum, item) => sum + item.plays, 0);
  return {
    denominator,
    items:
      used < denominator
        ? [
            ...items,
            {
              id: null,
              name: 'Other',
              plays: denominator - used,
              share: (denominator - used) / denominator,
            },
          ]
        : items,
  };
}

export async function analyticsData(
  database: PrismaClient,
  userId: string,
  range: ResolvedRange,
  weekStartsOn: number,
  options: AnalyticsOptions = {},
) {
  const granularity =
    options.granularity ?? adaptiveGranularity(range.from, range.to);
  const rankingLimit = options.rankingLimit ?? 25;
  const distributionLimit = options.distributionLimit ?? 10;
  const entity = options.entity;
  // The distribution "Other" bucket needs a top slice at least as long as the
  // ranking, so one query serves both.
  const topLimit = Math.max(rankingLimit, distributionLimit);

  /**
   * Every dimension is its own bounded aggregate: 24 hourly rows, 7 weekday
   * rows, 168 hour-weekday cells, 12 month rows, one row per time bucket, and
   * `topLimit` rows per ranking. The previous implementation loaded the whole
   * matching history -- and, for year-over-year, up to twenty further years of
   * it -- into Node first.
   */
  const [
    totals,
    timePoints,
    hourPoints,
    weekdayPoints,
    hourWeekdayPoints,
    monthPoints,
    bounds,
    rankedTracks,
    rankedAlbums,
    rankedArtists,
    artistDenominator,
    albumDenominator,
  ] = await Promise.all([
    totalsAggregate(database, userId, range, entity),
    timeBuckets(database, userId, range, granularity, weekStartsOn, entity),
    calendarBuckets(database, userId, range, 'hour', entity),
    calendarBuckets(database, userId, range, 'weekday', entity),
    calendarBuckets(database, userId, range, 'weekday_hour', entity),
    calendarBuckets(database, userId, range, 'month', entity),
    range.from
      ? Promise.resolve({ first: null, last: null })
      : playedAtBounds(database, userId, range, entity),
    rankedEntityPage(database, userId, range, 'track', {
      limit: topLimit,
      ...(entity ? { entity } : {}),
    }),
    rankedEntityPage(database, userId, range, 'album', {
      limit: topLimit,
      ...(entity ? { entity } : {}),
    }),
    rankedEntityPage(database, userId, range, 'artist', {
      limit: topLimit,
      ...(entity ? { entity } : {}),
    }),
    distributionDenominator(database, userId, range, 'artist', entity),
    distributionDenominator(database, userId, range, 'album', entity),
  ]);

  // Year-over-year. Without an explicit selection the years are those present
  // in the range; with one, each selected year is read over its full calendar
  // span, independent of the range.
  const inRangeYears = options.years?.length
    ? null
    : await yearDayBuckets(database, userId, range, entity);
  let yearDays = inRangeYears ?? new Map<number, Map<string, BucketPoint>>();
  const selectedYears = options.years?.length
    ? [...new Set(options.years)].sort((left, right) => left - right)
    : [...yearDays.keys()].sort((left, right) => left - right);
  if (options.years?.length) {
    const spans = await Promise.all(
      selectedYears.map((year) =>
        yearDayBuckets(
          database,
          userId,
          {
            preset: 'CUSTOM',
            from: zonedPartsToUtc(range.timezone, year, 1, 1),
            to: zonedPartsToUtc(range.timezone, year + 1, 1, 1),
            timezone: range.timezone,
          },
          entity,
        ),
      ),
    );
    yearDays = new Map();
    for (const span of spans)
      for (const [year, days] of span) yearDays.set(year, days);
  }

  const weekdayOrder = Array.from(
    { length: 7 },
    (_, index) => (weekStartsOn + index) % 7,
  );
  const timeFrom = range.from ?? bounds.first;

  return {
    totals,
    time: timeFrom
      ? fillSeries(
          timePoints,
          timeFrom,
          range.to,
          range.timezone,
          granularity,
          weekStartsOn,
        )
      : [],
    hourly: Array.from({ length: 24 }, (_, hour) => {
      const label = hour.toString().padStart(2, '0');
      return hourPoints.get(label) ?? emptyPoint(label);
    }),
    weekday: weekdayOrder.map((index) => {
      const name = weekdayNames[index]!;
      const point = weekdayPoints.get(String(index));
      return point ? { ...point, bucket: name } : emptyPoint(name);
    }),
    hourWeekday: weekdayOrder.map((index) => ({
      weekday: weekdayNames[index]!,
      points: Array.from({ length: 24 }, (_, hour) => {
        const label = hour.toString().padStart(2, '0');
        const point = hourWeekdayPoints.get(`${index}:${hour}`);
        return point ? { ...point, bucket: label } : emptyPoint(label);
      }),
    })),
    month: monthNames.map((name, index) => {
      const point = monthPoints.get(String(index + 1));
      return point ? { ...point, bucket: name } : emptyPoint(name);
    }),
    yearOverYear: selectedYears.map((year) => ({
      year,
      points: enumerateBuckets(
        zonedPartsToUtc(range.timezone, year, 1, 1),
        zonedPartsToUtc(range.timezone, year + 1, 1, 1),
        range.timezone,
        'day',
        weekStartsOn,
      ).map((start) => {
        const label = bucketLabel(start, range.timezone, 'day').slice(5);
        return yearDays.get(year)?.get(label) ?? emptyPoint(label);
      }),
    })),
    rankings: {
      artists: rankedArtists.items.slice(0, rankingLimit),
      albums: rankedAlbums.items.slice(0, rankingLimit),
      tracks: rankedTracks.items.slice(0, rankingLimit),
    },
    distributions: {
      artists: distribution(
        rankedArtists.items,
        artistDenominator,
        distributionLimit,
      ),
      albums: distribution(
        rankedAlbums.items,
        albumDenominator,
        distributionLimit,
      ),
    },
    bucketDefinitions: {
      interval: '[from,to)' as const,
      granularity,
      timezone: range.timezone,
      weekStartsOn,
      leapDay:
        'February 29 is a separate bucket; non-leap years contribute zero.',
    },
  };
}
