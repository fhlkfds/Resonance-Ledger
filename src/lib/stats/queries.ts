import type { Prisma, PrismaClient } from '@prisma/client';
import {
  adaptiveGranularity,
  bucketLabel,
  enumerateBuckets,
  startOfBucket,
  type ResolvedRange,
} from './dates';
import { normalizeName } from '@/lib/spotify/normalize';

const metricOrder = (left: RankedEntity, right: RankedEntity) =>
  right.plays - left.plays ||
  right.estimatedDurationMs - left.estimatedDurationMs ||
  left.normalizedName.localeCompare(right.normalizedName) ||
  left.id.localeCompare(right.id);

export type RankedEntity = {
  id: string;
  name: string;
  normalizedName: string;
  plays: number;
  estimatedDurationMs: number;
};

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

function eventWhere(
  userId: string,
  range: ResolvedRange,
  entity?: { kind: 'track' | 'artist' | 'album'; id: string },
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

type QueryClient = PrismaClient | Prisma.TransactionClient;

export async function dashboardData(
  database: QueryClient,
  userId: string,
  range: ResolvedRange,
  entity?: { kind: 'track' | 'artist' | 'album'; id: string },
  weekStartsOn = 1,
): Promise<DashboardData> {
  const events = await database.listeningHistory.findMany({
    where: eventWhere(userId, range, entity),
    select: {
      estimatedDurationMs: true,
      playedAt: true,
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
  const tracks = new Map<string, RankedEntity>();
  const albums = new Map<string, RankedEntity>();
  const artists = new Map<string, RankedEntity>();
  const days = new Map<
    string,
    { date: string; plays: number; estimatedDurationMs: number }
  >();
  const granularity = adaptiveGranularity(range.from, range.to);
  const trendBuckets = new Map<
    string,
    { bucket: string; plays: number; estimatedDurationMs: number }
  >();
  for (const event of events) {
    const accumulate = (
      map: Map<string, RankedEntity>,
      entity: { id: string; name: string; normalizedName: string },
    ) => {
      const value = map.get(entity.id) ?? {
        ...entity,
        plays: 0,
        estimatedDurationMs: 0,
      };
      value.plays += 1;
      value.estimatedDurationMs += event.estimatedDurationMs;
      map.set(entity.id, value);
    };
    accumulate(tracks, event.track);
    if (event.track.album) accumulate(albums, event.track.album);
    for (const credit of event.track.artists)
      accumulate(artists, credit.artist);
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: range.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(event.playedAt);
    const day = days.get(date) ?? { date, plays: 0, estimatedDurationMs: 0 };
    day.plays += 1;
    day.estimatedDurationMs += event.estimatedDurationMs;
    days.set(date, day);
    const trendLabel = bucketLabel(
      startOfBucket(event.playedAt, range.timezone, granularity, weekStartsOn),
      range.timezone,
      granularity,
    );
    const trendBucket = trendBuckets.get(trendLabel) ?? {
      bucket: trendLabel,
      plays: 0,
      estimatedDurationMs: 0,
    };
    trendBucket.plays += 1;
    trendBucket.estimatedDurationMs += event.estimatedDurationMs;
    trendBuckets.set(trendLabel, trendBucket);
  }
  const ranked = (values: Map<string, RankedEntity>) =>
    [...values.values()].sort(metricOrder);
  const mostActiveDay =
    [...days.values()].sort(
      (left, right) =>
        right.plays - left.plays ||
        right.estimatedDurationMs - left.estimatedDurationMs ||
        right.date.localeCompare(left.date),
    )[0] ?? null;
  const earliest = events.reduce<Date | null>(
    (value, event) =>
      !value || event.playedAt < value ? event.playedAt : value,
    null,
  );
  const trendFrom = range.from ?? earliest;
  const trend = trendFrom
    ? enumerateBuckets(
        trendFrom,
        range.to,
        range.timezone,
        granularity,
        weekStartsOn,
      ).map((start) => {
        const label = bucketLabel(start, range.timezone, granularity);
        return (
          trendBuckets.get(label) ?? {
            bucket: label,
            plays: 0,
            estimatedDurationMs: 0,
          }
        );
      })
    : [];
  return {
    totals: {
      plays: events.length,
      estimatedDurationMs: events.reduce(
        (sum, event) => sum + event.estimatedDurationMs,
        0,
      ),
      uniqueTracks: tracks.size,
      uniqueAlbums: albums.size,
      uniqueArtists: artists.size,
    },
    topTrack: ranked(tracks)[0] ?? null,
    topArtist: ranked(artists)[0] ?? null,
    topAlbum: ranked(albums)[0] ?? null,
    mostActiveDay,
    trend,
  };
}

export async function rankedEntities(
  database: PrismaClient,
  userId: string,
  range: ResolvedRange,
  kind: 'track' | 'artist' | 'album',
  query: string | undefined,
  sort: 'plays' | 'estimatedDuration' | 'name',
): Promise<RankedEntity[]> {
  const events = await database.listeningHistory.findMany({
    where: eventWhere(userId, range),
    select: {
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
  const values = new Map<string, RankedEntity>();
  for (const event of events) {
    const entities =
      kind === 'track'
        ? [event.track]
        : kind === 'album'
          ? event.track.album
            ? [event.track.album]
            : []
          : event.track.artists.map(({ artist }) => artist);
    for (const entity of entities) {
      const value = values.get(entity.id) ?? {
        ...entity,
        plays: 0,
        estimatedDurationMs: 0,
      };
      value.plays += 1;
      value.estimatedDurationMs += event.estimatedDurationMs;
      values.set(entity.id, value);
    }
  }
  const filtered = [...values.values()].filter(
    (entity) => !query || entity.normalizedName.includes(normalizeName(query)),
  );
  if (sort === 'name')
    return filtered.sort(
      (left, right) =>
        left.normalizedName.localeCompare(right.normalizedName) ||
        left.id.localeCompare(right.id),
    );
  if (sort === 'estimatedDuration') {
    return filtered.sort(
      (left, right) =>
        right.estimatedDurationMs - left.estimatedDurationMs ||
        right.plays - left.plays ||
        left.normalizedName.localeCompare(right.normalizedName) ||
        left.id.localeCompare(right.id),
    );
  }
  return filtered.sort(metricOrder);
}
