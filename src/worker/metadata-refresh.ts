import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Environment } from '@/lib/env';
import { fetchSpotifyMetadata } from '@/lib/spotify/client';
import { validAccessToken } from '@/lib/spotify/access-token';
import { normalizePlayedItem } from '@/lib/spotify/normalize';
import { upsertNormalizedTrack } from '@/lib/spotify/persist';

export const METADATA_REFRESH_BATCH = 20;
export const METADATA_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const METADATA_RECENT_MS = 30 * 24 * 60 * 60 * 1000;

type Dependencies = {
  fetcher?: typeof fetch;
  token?: typeof validAccessToken;
};

export async function refreshMetadata(
  database: PrismaClient,
  environment: Environment,
  now = new Date(),
  dependencies: Dependencies = {},
): Promise<number> {
  const staleBefore = new Date(now.getTime() - METADATA_STALE_MS);
  const recentAfter = new Date(now.getTime() - METADATA_RECENT_MS);
  const account = await database.spotifyAccount.findFirst({
    where: {
      state: 'ACTIVE',
      history: {
        some: {
          playedAt: { gte: recentAfter },
          track: {
            spotifyId: { not: null },
            metadataFetchedAt: { lt: staleBefore },
          },
        },
      },
    },
    orderBy: { updatedAt: 'asc' },
    select: { id: true },
  });
  if (!account) return 0;

  const recent = await database.listeningHistory.findMany({
    where: {
      spotifyAccountId: account.id,
      playedAt: { gte: recentAfter },
      track: {
        spotifyId: { not: null },
        metadataFetchedAt: { lt: staleBefore },
      },
    },
    orderBy: { playedAt: 'desc' },
    take: METADATA_REFRESH_BATCH * 5,
    select: { track: { select: { spotifyId: true } } },
  });
  const trackIds = [
    ...new Set(
      recent.flatMap(({ track }) => (track.spotifyId ? [track.spotifyId] : [])),
    ),
  ].slice(0, METADATA_REFRESH_BATCH);
  if (!trackIds.length) return 0;

  const token = await (dependencies.token ?? validAccessToken)(
    database,
    account.id,
    environment,
    now,
  );
  const metadata = await fetchSpotifyMetadata(token, trackIds, {
    requestId: randomUUID(),
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
  });
  const artistImages = new Map(
    metadata.artists.flatMap((artist) =>
      artist?.id ? [[artist.id, artist.images[0]?.url ?? null] as const] : [],
    ),
  );

  let refreshed = 0;
  await database.$transaction(async (transaction) => {
    for (const track of metadata.tracks) {
      if (!track?.id || !trackIds.includes(track.id)) continue;
      const normalized = normalizePlayedItem({
        played_at: now.toISOString(),
        track,
      }).track;
      const addImages = (artist: (typeof normalized.artists)[number]) => ({
        ...artist,
        imageUrl: artist.spotifyId
          ? (artistImages.get(artist.spotifyId) ?? artist.imageUrl)
          : artist.imageUrl,
      });
      await upsertNormalizedTrack(
        transaction,
        {
          ...normalized,
          artists: normalized.artists.map(addImages),
          album: normalized.album
            ? {
                ...normalized.album,
                artists: normalized.album.artists.map(addImages),
              }
            : null,
        },
        now,
      );
      refreshed += 1;
    }
  });
  return refreshed;
}
