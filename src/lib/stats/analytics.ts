import type { Prisma, PrismaClient } from '@prisma/client';
import {
  adaptiveGranularity,
  bucketLabel,
  enumerateBuckets,
  startOfBucket,
  utcToZonedParts,
  zonedPartsToUtc,
  type Granularity,
  type ResolvedRange,
} from './dates';
import type { RankedEntity } from './queries';

type MetricPoint = {
  bucket: string;
  plays: number;
  estimatedDurationMs: number;
};

type AnalyticsOptions = {
  granularity?: Granularity;
  rankingLimit?: number;
  distributionLimit?: number;
  years?: number[];
  entity?: { kind: 'track' | 'artist' | 'album'; id: string };
};

function eventWhere(
  userId: string,
  range: ResolvedRange,
  entity?: AnalyticsOptions['entity'],
): Prisma.ListeningHistoryWhereInput {
  return {
    spotifyAccount: { userId },
    playedAt: { ...(range.from ? { gte: range.from } : {}), lt: range.to },
    ...(entity?.kind === 'track' ? { trackId: entity.id } : {}),
    ...(entity?.kind === 'album' ? { track: { albumId: entity.id } } : {}),
    ...(entity?.kind === 'artist'
      ? { track: { artists: { some: { artistId: entity.id } } } }
      : {}),
  };
}

function increment(
  map: Map<string, MetricPoint>,
  bucket: string,
  duration: number,
) {
  const point = map.get(bucket) ?? {
    bucket,
    plays: 0,
    estimatedDurationMs: 0,
  };
  point.plays += 1;
  point.estimatedDurationMs += duration;
  map.set(bucket, point);
}

function addEntity(
  map: Map<string, RankedEntity>,
  entity: { id: string; name: string; normalizedName: string },
  duration: number,
) {
  const value = map.get(entity.id) ?? {
    ...entity,
    plays: 0,
    estimatedDurationMs: 0,
  };
  value.plays += 1;
  value.estimatedDurationMs += duration;
  map.set(entity.id, value);
}

export const rankOrder = (left: RankedEntity, right: RankedEntity) =>
  right.plays - left.plays ||
  right.estimatedDurationMs - left.estimatedDurationMs ||
  left.normalizedName.localeCompare(right.normalizedName) ||
  left.id.localeCompare(right.id);

function distribution(values: RankedEntity[], limit: number) {
  const total = values.reduce((sum, item) => sum + item.plays, 0);
  const top = values.slice(0, limit).map((item) => ({
    id: item.id,
    name: item.name,
    plays: item.plays,
    share: total ? item.plays / total : 0,
  }));
  const used = top.reduce((sum, item) => sum + item.plays, 0);
  return {
    denominator: total,
    items:
      used < total
        ? [
            ...top,
            {
              id: null,
              name: 'Other',
              plays: total - used,
              share: (total - used) / total,
            },
          ]
        : top,
  };
}

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

export async function analyticsData(
  database: PrismaClient,
  userId: string,
  range: ResolvedRange,
  weekStartsOn: number,
  options: AnalyticsOptions = {},
) {
  const events = await database.listeningHistory.findMany({
    where: eventWhere(userId, range, options.entity),
    select: {
      playedAt: true,
      estimatedDurationMs: true,
      track: {
        select: {
          id: true,
          name: true,
          normalizedName: true,
          album: { select: { id: true, name: true, normalizedName: true } },
          artists: {
            select: {
              artist: {
                select: { id: true, name: true, normalizedName: true },
              },
            },
          },
        },
      },
    },
  });
  const granularity =
    options.granularity ?? adaptiveGranularity(range.from, range.to);
  const time = new Map<string, MetricPoint>();
  const hours = new Map<string, MetricPoint>();
  const weekdays = new Map<string, MetricPoint>();
  const hourWeekdays = new Map<string, MetricPoint>();
  const months = new Map<string, MetricPoint>();
  const yearDays = new Map<number, Map<string, MetricPoint>>();
  const tracks = new Map<string, RankedEntity>();
  const albums = new Map<string, RankedEntity>();
  const artists = new Map<string, RankedEntity>();

  for (const event of events) {
    const parts = utcToZonedParts(event.playedAt, range.timezone);
    const timeLabel = bucketLabel(
      startOfBucket(event.playedAt, range.timezone, granularity, weekStartsOn),
      range.timezone,
      granularity,
    );
    increment(time, timeLabel, event.estimatedDurationMs);
    increment(
      hours,
      parts.hour.toString().padStart(2, '0'),
      event.estimatedDurationMs,
    );
    increment(
      weekdays,
      weekdayNames[parts.weekday]!,
      event.estimatedDurationMs,
    );
    increment(
      hourWeekdays,
      `${weekdayNames[parts.weekday]}:${parts.hour}`,
      event.estimatedDurationMs,
    );
    increment(months, monthNames[parts.month - 1]!, event.estimatedDurationMs);
    const year = yearDays.get(parts.year) ?? new Map<string, MetricPoint>();
    increment(
      year,
      `${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`,
      event.estimatedDurationMs,
    );
    yearDays.set(parts.year, year);
    addEntity(tracks, event.track, event.estimatedDurationMs);
    if (event.track.album)
      addEntity(albums, event.track.album, event.estimatedDurationMs);
    for (const credit of event.track.artists)
      addEntity(artists, credit.artist, event.estimatedDurationMs);
  }

  const earliest = events.reduce<Date | null>(
    (result, event) =>
      !result || event.playedAt < result ? event.playedAt : result,
    null,
  );
  const timeFrom = range.from ?? earliest;
  const rankedTracks = [...tracks.values()].sort(rankOrder);
  const rankedAlbums = [...albums.values()].sort(rankOrder);
  const rankedArtists = [...artists.values()].sort(rankOrder);
  const selectedYears = options.years?.length
    ? [...new Set(options.years)].sort((a, b) => a - b)
    : [...yearDays.keys()].sort((a, b) => a - b);
  if (options.years?.length) {
    const selectedYearEvents = await database.listeningHistory.findMany({
      where: {
        spotifyAccount: { userId },
        OR: selectedYears.map((year) => ({
          playedAt: {
            gte: zonedPartsToUtc(range.timezone, year, 1, 1),
            lt: zonedPartsToUtc(range.timezone, year + 1, 1, 1),
          },
        })),
        ...(options.entity?.kind === 'track'
          ? { trackId: options.entity.id }
          : {}),
        ...(options.entity?.kind === 'album'
          ? { track: { albumId: options.entity.id } }
          : {}),
        ...(options.entity?.kind === 'artist'
          ? {
              track: {
                artists: { some: { artistId: options.entity.id } },
              },
            }
          : {}),
      },
      select: { playedAt: true, estimatedDurationMs: true },
    });
    yearDays.clear();
    for (const event of selectedYearEvents) {
      const parts = utcToZonedParts(event.playedAt, range.timezone);
      const year = yearDays.get(parts.year) ?? new Map<string, MetricPoint>();
      increment(
        year,
        `${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`,
        event.estimatedDurationMs,
      );
      yearDays.set(parts.year, year);
    }
  }
  const weekdayOrder = Array.from(
    { length: 7 },
    (_, index) => weekdayNames[(weekStartsOn + index) % 7]!,
  );
  const totalDuration = events.reduce(
    (sum, event) => sum + event.estimatedDurationMs,
    0,
  );

  return {
    totals: {
      plays: events.length,
      estimatedDurationMs: totalDuration,
      uniqueTracks: tracks.size,
      uniqueAlbums: albums.size,
      uniqueArtists: artists.size,
      artistPlayCredits: rankedArtists.reduce(
        (sum, item) => sum + item.plays,
        0,
      ),
    },
    time: timeFrom
      ? enumerateBuckets(
          timeFrom,
          range.to,
          range.timezone,
          granularity,
          weekStartsOn,
        ).map((start) => {
          const label = bucketLabel(start, range.timezone, granularity);
          return (
            time.get(label) ?? {
              bucket: label,
              plays: 0,
              estimatedDurationMs: 0,
            }
          );
        })
      : [],
    hourly: Array.from({ length: 24 }, (_, hour) => {
      const label = hour.toString().padStart(2, '0');
      return (
        hours.get(label) ?? { bucket: label, plays: 0, estimatedDurationMs: 0 }
      );
    }),
    weekday: weekdayOrder.map(
      (label) =>
        weekdays.get(label) ?? {
          bucket: label,
          plays: 0,
          estimatedDurationMs: 0,
        },
    ),
    hourWeekday: weekdayOrder.map((weekday) => ({
      weekday,
      points: Array.from({ length: 24 }, (_, hour) => {
        const label = hour.toString().padStart(2, '0');
        return (
          hourWeekdays.get(`${weekday}:${hour}`) ?? {
            bucket: label,
            plays: 0,
            estimatedDurationMs: 0,
          }
        );
      }),
    })),
    month: monthNames.map(
      (label) =>
        months.get(label) ?? {
          bucket: label,
          plays: 0,
          estimatedDurationMs: 0,
        },
    ),
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
        return (
          yearDays.get(year)?.get(label) ?? {
            bucket: label,
            plays: 0,
            estimatedDurationMs: 0,
          }
        );
      }),
    })),
    rankings: {
      artists: rankedArtists.slice(0, options.rankingLimit ?? 25),
      albums: rankedAlbums.slice(0, options.rankingLimit ?? 25),
      tracks: rankedTracks.slice(0, options.rankingLimit ?? 25),
    },
    distributions: {
      artists: distribution(rankedArtists, options.distributionLimit ?? 10),
      albums: distribution(rankedAlbums, options.distributionLimit ?? 10),
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
