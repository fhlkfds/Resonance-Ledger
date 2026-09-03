import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { type Environment } from '@/lib/env';
import { fetchRecentlyPlayed } from '@/lib/spotify/client';
import { persistSyncBatch, recordSyncFailure } from '@/lib/spotify/persist';
import { validAccessToken } from '@/lib/spotify/access-token';

export async function syncLeasedAccount(
  database: PrismaClient,
  accountId: string,
  workerId: string,
  environment: Environment,
): Promise<void> {
  const requestId = randomUUID();
  try {
    const state = await database.syncState.findUniqueOrThrow({
      where: { spotifyAccountId: accountId },
    });
    const accessToken = await validAccessToken(
      database,
      accountId,
      environment,
    );
    const after = Math.max(
      0,
      (state.cursorPlayedAt?.getTime() ?? 0) -
        environment.SYNC_OVERLAP_SECONDS * 1000,
    );
    const result = await fetchRecentlyPlayed(accessToken, after, { requestId });
    await persistSyncBatch(database, {
      accountId,
      workerId,
      requestId,
      ...result,
      intervalSeconds: environment.SYNC_INTERVAL_SECONDS,
      overlapSeconds: environment.SYNC_OVERLAP_SECONDS,
    });
  } catch (error) {
    await recordSyncFailure(
      database,
      accountId,
      workerId,
      requestId,
      error instanceof Error ? error.name : 'UnknownError',
    );
  }
}
