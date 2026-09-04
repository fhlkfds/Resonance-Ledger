import type { PrismaClient } from '@prisma/client';
import { ApiRepository } from '@/lib/db/repositories/api';
import { dashboardData } from './queries';
import { entityRank, playedAtBounds, rankedEntityPage } from './aggregate';
import { eventWhere, type EntityKind } from './scope';
import type { ResolvedRange } from './dates';

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

  const scope = { kind, id } as const;
  // Every one of these is bounded: ten rows, ten rows, ten rows, one row,
  // one row. The previous implementation loaded the entity's whole history
  // and then sliced ten items off the front of it.
  const [summary, bounds, topTracks, topAlbums, recentPlays, rank] =
    await Promise.all([
      dashboardData(database, userId, range, scope, weekStartsOn),
      playedAtBounds(database, userId, range, scope),
      rankedEntityPage(database, userId, range, 'track', {
        limit: 10,
        entity: scope,
      }),
      rankedEntityPage(database, userId, range, 'album', {
        limit: 10,
        entity: scope,
      }),
      database.listeningHistory.findMany({
        where: eventWhere(userId, range, scope),
        orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
        take: 10,
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
      // An artist's standing among all the user's artists, computed by a
      // window function rather than by ranking every artist in Node.
      kind === 'artist'
        ? entityRank(database, userId, range, 'artist', id)
        : Promise.resolve(null),
    ]);

  return {
    kind,
    entity,
    totals: summary.totals,
    trend: summary.trend,
    firstPlayedAt: bounds.first,
    lastPlayedAt: bounds.last,
    rank: rank && rank > 0 ? rank : null,
    topTracks: topTracks.items,
    topAlbums: topAlbums.items,
    recentPlays,
  };
}
