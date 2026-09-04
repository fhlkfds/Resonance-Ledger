import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { type Environment } from '@/lib/env';
import {
  type ClientOptions,
  fetchRecentlyPlayed,
  SpotifyRateLimitError,
} from '@/lib/spotify/client';
import {
  LeaseLostError,
  persistSyncBatch,
  recordRateLimited,
  recordSyncFailure,
} from '@/lib/spotify/persist';
import { heartbeatLease } from '@/lib/db/repositories/sync';
import { validAccessToken } from '@/lib/spotify/access-token';

/**
 * Test seam for the provider HTTP boundary. Production passes nothing; the
 * integration suite substitutes a fake slow provider so lease expiry mid-run
 * can be exercised against a real database.
 */
export type SyncClientOverrides = Pick<
  ClientOptions,
  'fetcher' | 'sleep' | 'random'
>;

export async function syncLeasedAccount(
  database: PrismaClient,
  accountId: string,
  workerId: string,
  environment: Environment,
  signal?: AbortSignal,
  overrides?: SyncClientOverrides,
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
    const result = await fetchRecentlyPlayed(accessToken, after, {
      ...overrides,
      requestId,
      signal,
      // The lease is 120s, but a run is up to ten pages with five attempts
      // each and backoff between them. Without renewal the lease expires
      // mid-run, a second worker is granted one, and this run's entire batch
      // is thrown away by the guard in persistSyncBatch. Renewing at every
      // page boundary and before every retry wait keeps the lease alive; if
      // it has already been taken, this throws and the run aborts.
      heartbeat: async () => {
        const held = await heartbeatLease(database, accountId, workerId);
        if (!held) throw new LeaseLostError();
      },
    });
    await persistSyncBatch(database, {
      accountId,
      workerId,
      requestId,
      ...result,
      intervalSeconds: environment.SYNC_INTERVAL_SECONDS,
      overlapSeconds: environment.SYNC_OVERLAP_SECONDS,
    });
  } catch (error) {
    // A rate limit is a deferral, not a failure: end the run as RATE_LIMITED
    // and leave the cursor where it was so the retry resumes from it.
    if (error instanceof SpotifyRateLimitError) {
      await recordRateLimited(
        database,
        accountId,
        workerId,
        requestId,
        error.retryAfterSeconds,
      );
      return;
    }
    await recordSyncFailure(
      database,
      accountId,
      workerId,
      requestId,
      error instanceof Error ? error.name : 'UnknownError',
    );
  }
}
