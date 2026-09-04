import type { Prisma, PrismaClient } from '@prisma/client';
import type { TimeCursor } from '@/lib/api/pagination';
import type { ResolvedRange } from '@/lib/stats/dates';
import { normalizeName } from '@/lib/spotify/normalize';

function rangeWhere(range: ResolvedRange): Prisma.DateTimeFilter {
  return { ...(range.from ? { gte: range.from } : {}), lt: range.to };
}

export class ApiRepository {
  constructor(private readonly database: PrismaClient) {}

  settings(userId: string) {
    return this.database.userSettings.findUniqueOrThrow({ where: { userId } });
  }

  me(userId: string) {
    return this.database.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        consentVersion: true,
        consentedAt: true,
        settings: true,
        spotifyAccount: {
          select: {
            id: true,
            displayName: true,
            state: true,
            refreshTokenExpiresAt: true,
            syncState: true,
          },
        },
      },
    });
  }

  history(
    userId: string,
    input: {
      range: ResolvedRange;
      limit: number;
      cursor: TimeCursor | null;
      q?: string;
      artistId?: string;
      albumId?: string;
      trackId?: string;
      explicit?: boolean;
    },
  ) {
    const cursorDate = input.cursor ? new Date(input.cursor.at) : null;
    return this.database.listeningHistory.findMany({
      where: {
        spotifyAccount: { userId },
        playedAt: rangeWhere(input.range),
        ...(input.cursor && cursorDate
          ? {
              OR: [
                { playedAt: { lt: cursorDate } },
                { playedAt: cursorDate, id: { lt: input.cursor.id } },
              ],
            }
          : {}),
        ...(input.trackId ? { trackId: input.trackId } : {}),
        track: {
          ...(input.q
            ? {
                normalizedName: {
                  contains: normalizeName(input.q),
                  mode: 'insensitive',
                },
              }
            : {}),
          ...(input.albumId ? { albumId: input.albumId } : {}),
          ...(input.artistId
            ? { artists: { some: { artistId: input.artistId } } }
            : {}),
          ...(input.explicit === undefined ? {} : { explicit: input.explicit }),
        },
      },
      orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      include: {
        track: {
          include: {
            album: { select: { id: true, name: true, artworkUrl: true } },
            artists: {
              orderBy: { position: 'asc' },
              include: { artist: { select: { id: true, name: true } } },
            },
          },
        },
      },
    });
  }

  entityForUser(
    userId: string,
    kind: 'track' | 'artist' | 'album',
    id: string,
  ) {
    if (kind === 'track') {
      return this.database.track.findFirst({
        where: { id, history: { some: { spotifyAccount: { userId } } } },
        include: {
          album: true,
          artists: { orderBy: { position: 'asc' }, include: { artist: true } },
        },
      });
    }
    if (kind === 'artist') {
      return this.database.artist.findFirst({
        where: {
          id,
          tracks: {
            some: {
              track: { history: { some: { spotifyAccount: { userId } } } },
            },
          },
        },
      });
    }
    return this.database.album.findFirst({
      where: {
        id,
        tracks: { some: { history: { some: { spotifyAccount: { userId } } } } },
      },
      include: {
        artists: { orderBy: { position: 'asc' }, include: { artist: true } },
      },
    });
  }

  syncStatus(userId: string, limit: number) {
    return this.database.spotifyAccount.findFirst({
      where: { userId },
      select: {
        state: true,
        refreshTokenExpiresAt: true,
        syncState: true,
        syncRuns: {
          orderBy: { startedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            startedAt: true,
            finishedAt: true,
            outcome: true,
            pagesFetched: true,
            itemsFetched: true,
            eventsInserted: true,
            duplicates: true,
            errorClass: true,
            requestId: true,
          },
        },
      },
    });
  }
}
