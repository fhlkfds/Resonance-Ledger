import type { Prisma, PrismaClient } from '@prisma/client';
import {
  normalizePlayedItem,
  type NormalizedArtist,
  type NormalizedPlay,
} from './normalize';
import type { SpotifyPlayedItem } from './schemas';

function deterministicJitter(accountId: string): number {
  let hash = 0;
  for (const character of accountId)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 21;
}

async function upsertArtist(
  transaction: Prisma.TransactionClient,
  artist: NormalizedArtist,
  now: Date,
): Promise<string> {
  const row = await transaction.artist.upsert({
    where: { externalKey: artist.externalKey },
    create: { ...artist, metadataFetchedAt: now },
    update: {
      name: artist.name,
      normalizedName: artist.normalizedName,
      spotifyUri: artist.spotifyUri,
      ...(artist.imageUrl ? { imageUrl: artist.imageUrl } : {}),
      metadataFetchedAt: now,
    },
    select: { id: true },
  });
  return row.id;
}

export async function upsertNormalizedTrack(
  transaction: Prisma.TransactionClient,
  track: NormalizedPlay['track'],
  now: Date,
): Promise<string> {
  const album = track.album;
  let albumId: string | null = null;
  if (album) {
    const saved = await transaction.album.upsert({
      where: { externalKey: album.externalKey },
      create: {
        externalKey: album.externalKey,
        spotifyId: album.spotifyId,
        name: album.name,
        normalizedName: album.normalizedName,
        albumType: album.albumType,
        releaseDateText: album.releaseDateText,
        releaseDatePrecision: album.releaseDatePrecision,
        releaseYear: album.releaseYear,
        spotifyUri: album.spotifyUri,
        artworkUrl: album.artworkUrl,
        metadataFetchedAt: now,
      },
      update: {
        name: album.name,
        normalizedName: album.normalizedName,
        albumType: album.albumType,
        releaseDateText: album.releaseDateText,
        releaseDatePrecision: album.releaseDatePrecision,
        releaseYear: album.releaseYear,
        spotifyUri: album.spotifyUri,
        artworkUrl: album.artworkUrl,
        metadataFetchedAt: now,
      },
      select: { id: true },
    });
    albumId = saved.id;
    const artistIds = await Promise.all(
      album.artists.map((artist) => upsertArtist(transaction, artist, now)),
    );
    await transaction.albumArtist.deleteMany({ where: { albumId } });
    if (artistIds.length)
      await transaction.albumArtist.createMany({
        data: artistIds.map((artistId, position) => ({
          albumId: saved.id,
          artistId,
          position,
        })),
      });
  }
  const savedTrack = await transaction.track.upsert({
    where: { externalKey: track.externalKey },
    create: {
      externalKey: track.externalKey,
      spotifyId: track.spotifyId,
      albumId,
      name: track.name,
      normalizedName: track.normalizedName,
      durationMs: track.durationMs,
      discNumber: track.discNumber,
      trackNumber: track.trackNumber,
      explicit: track.explicit,
      isLocal: track.isLocal,
      spotifyUri: track.spotifyUri,
      isrc: track.isrc,
      metadataFetchedAt: now,
    },
    update: {
      albumId,
      name: track.name,
      normalizedName: track.normalizedName,
      durationMs: track.durationMs,
      discNumber: track.discNumber,
      trackNumber: track.trackNumber,
      explicit: track.explicit,
      spotifyUri: track.spotifyUri,
      isrc: track.isrc,
      metadataFetchedAt: now,
    },
    select: { id: true },
  });
  const artistIds = await Promise.all(
    track.artists.map((artist) => upsertArtist(transaction, artist, now)),
  );
  await transaction.trackArtist.deleteMany({
    where: { trackId: savedTrack.id },
  });
  if (artistIds.length)
    await transaction.trackArtist.createMany({
      data: artistIds.map((artistId, position) => ({
        trackId: savedTrack.id,
        artistId,
        position,
      })),
    });
  return savedTrack.id;
}

export async function persistSyncBatch(
  database: PrismaClient,
  input: {
    accountId: string;
    workerId: string;
    requestId: string;
    items: SpotifyPlayedItem[];
    pagesFetched: number;
    bounded: boolean;
    intervalSeconds: number;
    overlapSeconds: number;
    now?: Date;
  },
): Promise<{
  inserted: number;
  duplicates: number;
  probableGap: boolean;
  cursor: Date | null;
}> {
  const now = input.now ?? new Date();
  const plays = input.items
    .map(normalizePlayedItem)
    .sort((left, right) => left.playedAt.getTime() - right.playedAt.getTime());
  return database.$transaction(async (transaction) => {
    const state = await transaction.syncState.findUniqueOrThrow({
      where: { spotifyAccountId: input.accountId },
    });
    if (
      state.leaseOwner !== input.workerId ||
      !state.leaseExpiresAt ||
      state.leaseExpiresAt <= now
    )
      throw new Error('Sync lease is not owned or has expired');
    let inserted = 0;
    for (const play of plays) {
      const trackId = await upsertNormalizedTrack(transaction, play.track, now);
      const event = await transaction.listeningHistory.createMany({
        data: [
          {
            spotifyAccountId: input.accountId,
            trackId,
            playedAt: play.playedAt,
            estimatedDurationMs: play.estimatedDurationMs,
          },
        ],
        skipDuplicates: true,
      });
      inserted += event.count;
    }
    const cursor = plays.at(-1)?.playedAt ?? state.cursorPlayedAt;
    const oldest = plays[0]?.playedAt;
    const probableGap = Boolean(
      state.probableGap ||
      (input.bounded &&
        state.cursorPlayedAt &&
        oldest &&
        oldest.getTime() >
          state.cursorPlayedAt.getTime() + input.overlapSeconds * 1000),
    );
    await transaction.syncState.update({
      where: { spotifyAccountId: input.accountId },
      data: {
        status: 'IDLE',
        cursorPlayedAt: cursor,
        nextSyncAt: new Date(
          now.getTime() +
            (input.intervalSeconds + deterministicJitter(input.accountId)) *
              1000,
        ),
        lastSuccessAt: now,
        consecutiveFailures: 0,
        probableGap,
        gapDetectedAt: probableGap ? (state.gapDetectedAt ?? now) : null,
        gapReason: probableGap
          ? (state.gapReason ?? 'bounded_recently_played_window')
          : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        workerHeartbeatAt: now,
      },
    });
    await transaction.syncRun.create({
      data: {
        spotifyAccountId: input.accountId,
        startedAt: state.lastAttemptAt ?? now,
        finishedAt: now,
        outcome: input.bounded ? 'PARTIAL' : 'SUCCEEDED',
        pagesFetched: input.pagesFetched,
        itemsFetched: plays.length,
        eventsInserted: inserted,
        duplicates: plays.length - inserted,
        requestId: input.requestId,
      },
    });
    return {
      inserted,
      duplicates: plays.length - inserted,
      probableGap,
      cursor,
    };
  });
}

export async function recordSyncFailure(
  database: PrismaClient,
  accountId: string,
  workerId: string,
  requestId: string,
  errorClass: string,
  now = new Date(),
): Promise<void> {
  await database.$transaction(async (transaction) => {
    const state = await transaction.syncState.findUnique({
      where: { spotifyAccountId: accountId },
    });
    if (!state || state.leaseOwner !== workerId) return;
    const failures = state.consecutiveFailures + 1;
    const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(failures - 1, 6));
    await transaction.syncState.update({
      where: { spotifyAccountId: accountId },
      data: {
        status: 'BACKOFF',
        consecutiveFailures: failures,
        nextSyncAt: new Date(now.getTime() + backoff),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    await transaction.syncRun.create({
      data: {
        spotifyAccountId: accountId,
        startedAt: state.lastAttemptAt ?? now,
        finishedAt: now,
        outcome: 'FAILED',
        errorClass: errorClass.slice(0, 100),
        requestId,
      },
    });
  });
}
