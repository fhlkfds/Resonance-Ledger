import type { Prisma, PrismaClient } from '@prisma/client';
import { ApiRepository } from '@/lib/db/repositories/api';
import { dashboardData, rankedEntities, type RankedEntity } from './queries';
import type { ResolvedRange } from './dates';

type EntityKind = 'track' | 'artist' | 'album';

function scopedWhere(
  userId: string,
  range: ResolvedRange,
  kind: EntityKind,
  id: string,
): Prisma.ListeningHistoryWhereInput {
  return {
    spotifyAccount: { userId },
    playedAt: { ...(range.from ? { gte: range.from } : {}), lt: range.to },
    ...(kind === 'track' ? { trackId: id } : {}),
    ...(kind === 'album' ? { track: { albumId: id } } : {}),
    ...(kind === 'artist'
      ? { track: { artists: { some: { artistId: id } } } }
      : {}),
  };
}

function addRanked(
  values: Map<string, RankedEntity>,
  entity: { id: string; name: string; normalizedName: string },
  duration: number,
) {
  const value = values.get(entity.id) ?? {
    ...entity,
    plays: 0,
    estimatedDurationMs: 0,
  };
  value.plays += 1;
  value.estimatedDurationMs += duration;
  values.set(entity.id, value);
}

const rankedOrder = (left: RankedEntity, right: RankedEntity) =>
  right.plays - left.plays ||
  right.estimatedDurationMs - left.estimatedDurationMs ||
  left.normalizedName.localeCompare(right.normalizedName) ||
  left.id.localeCompare(right.id);

export async function entityDetailData(
  database: PrismaClient,
  userId: string,
  range: ResolvedRange,
  weekStartsOn: number,
  kind: EntityKind,
  id: string,
) {
  const repository = new ApiRepository(database);
  const entity = await repository.entityForUser(userId, kind, id);
  if (!entity) return null;

  const where = scopedWhere(userId, range, kind, id);
  const [summary, events] = await Promise.all([
    dashboardData(database, userId, range, { kind, id }, weekStartsOn),
    database.listeningHistory.findMany({
      where,
      orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        playedAt: true,
        estimatedDurationMs: true,
        track: {
          select: {
            id: true,
            name: true,
            normalizedName: true,
            album: {
              select: {
                id: true,
                name: true,
                normalizedName: true,
                artworkUrl: true,
              },
            },
            artists: {
              orderBy: { position: 'asc' },
              select: {
                artist: {
                  select: { id: true, name: true, normalizedName: true },
                },
              },
            },
          },
        },
      },
    }),
  ]);
  const tracks = new Map<string, RankedEntity>();
  const albums = new Map<string, RankedEntity>();
  for (const event of events) {
    addRanked(tracks, event.track, event.estimatedDurationMs);
    if (event.track.album)
      addRanked(albums, event.track.album, event.estimatedDurationMs);
  }
  const first = events.at(-1)?.playedAt ?? null;
  const last = events.at(0)?.playedAt ?? null;
  const rank =
    kind === 'artist'
      ? (
          await rankedEntities(
            database,
            userId,
            range,
            'artist',
            undefined,
            'plays',
          )
        ).findIndex((item) => item.id === id) + 1
      : null;

  return {
    kind,
    entity,
    totals: summary.totals,
    trend: summary.trend,
    firstPlayedAt: first,
    lastPlayedAt: last,
    rank: rank && rank > 0 ? rank : null,
    topTracks: [...tracks.values()].sort(rankedOrder).slice(0, 10),
    topAlbums: [...albums.values()].sort(rankedOrder).slice(0, 10),
    recentPlays: events.slice(0, 10),
  };
}
