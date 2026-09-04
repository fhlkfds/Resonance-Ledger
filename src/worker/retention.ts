/**
 * Retention, cleanup, and deferred deletion.
 *
 * Runs daily from the worker. Every step is bounded so a large installation
 * degrades into more passes rather than one long transaction holding locks.
 *
 * The retention window is disclosed in the privacy policy, so this job is what
 * makes that disclosure true. "All retained history" must never come to mean
 * perpetual retention.
 */
import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/observability/logger';

/** Rows removed per statement, so no single delete holds locks for long. */
const BATCH_SIZE = 5_000;

/** Spotify's Data Protection Appendix requires deletion within five days. */
export const DELETION_DEADLINE_DAYS = 5;

export type RetentionSummary = {
  historyDeleted: number;
  tracksPurged: number;
  albumsPurged: number;
  artistsPurged: number;
  sessionsDeleted: number;
  oauthStatesDeleted: number;
  syncRunsDeleted: number;
  accountsDeleted: number;
  deletionsOverdue: number;
};

const emptySummary = (): RetentionSummary => ({
  historyDeleted: 0,
  tracksPurged: 0,
  albumsPurged: 0,
  artistsPurged: 0,
  sessionsDeleted: 0,
  oauthStatesDeleted: 0,
  syncRunsDeleted: 0,
  accountsDeleted: 0,
  deletionsOverdue: 0,
});

/**
 * Delete listening events past each user's own disclosed cutoff.
 *
 * The cutoff is per user because retention is a user-visible setting, not a
 * single global constant.
 */
async function deleteExpiredHistory(
  database: PrismaClient,
  now: Date,
): Promise<number> {
  const settings = await database.userSettings.findMany({
    select: { userId: true, retentionDays: true },
  });

  let deleted = 0;
  for (const { userId, retentionDays } of settings) {
    // A non-positive value would mean perpetual retention, which the policy
    // forbids; treat it as the specification default instead of deleting all.
    const days = retentionDays > 0 ? retentionDays : 730;
    const cutoff = new Date(now.getTime() - days * 86_400_000);

    for (;;) {
      const expired = await database.listeningHistory.findMany({
        where: { spotifyAccount: { userId }, playedAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      });
      if (expired.length === 0) break;
      const result = await database.listeningHistory.deleteMany({
        where: { id: { in: expired.map((row) => row.id) } },
      });
      deleted += result.count;
      if (expired.length < BATCH_SIZE) break;
    }
  }
  return deleted;
}

/**
 * Remove metadata no longer referenced by any retained event.
 *
 * Order matters: tracks first, because dropping them is what can orphan an
 * album, and albums before artists for the same reason.
 */
async function purgeOrphanedMetadata(database: PrismaClient) {
  const tracks = await database.track.deleteMany({
    where: { history: { none: {} } },
  });
  const albums = await database.album.deleteMany({
    where: { tracks: { none: {} } },
  });
  const artists = await database.artist.deleteMany({
    where: { tracks: { none: {} }, albums: { none: {} } },
  });
  return {
    tracksPurged: tracks.count,
    albumsPurged: albums.count,
    artistsPurged: artists.count,
  };
}

/**
 * Finish disconnections that did not complete synchronously.
 *
 * An account left in DELETING is retried here. Passing the five-day contractual
 * deadline is an operator-visible warning, not a silent condition.
 */
async function completePendingDeletions(
  database: PrismaClient,
  now: Date,
): Promise<{ accountsDeleted: number; deletionsOverdue: number }> {
  const pending = await database.spotifyAccount.findMany({
    where: { state: 'DELETING' },
    select: { id: true, userId: true, updatedAt: true },
  });

  let accountsDeleted = 0;
  let deletionsOverdue = 0;
  const deadline = new Date(
    now.getTime() - DELETION_DEADLINE_DAYS * 86_400_000,
  );

  for (const account of pending) {
    if (account.updatedAt < deadline) {
      deletionsOverdue += 1;
      logger.warn(
        { event: 'retention.deletion_overdue', accountId: account.id },
        'a disconnection has passed the five-day deletion deadline',
      );
    }
    try {
      await database.$transaction(async (transaction) => {
        await transaction.appSession.updateMany({
          where: { userId: account.userId, revokedAt: null },
          data: { revokedAt: now },
        });
        await transaction.spotifyAccount.delete({ where: { id: account.id } });
        await transaction.user.update({
          where: { id: account.userId },
          data: { status: 'DISCONNECTED', deletedAt: now },
        });
      });
      accountsDeleted += 1;
    } catch (error) {
      // Leave the account in DELETING so the next pass retries it.
      logger.error(
        {
          event: 'retention.deletion_failed',
          accountId: account.id,
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        },
        'deferred deletion failed and will be retried',
      );
    }
  }
  return { accountsDeleted, deletionsOverdue };
}

/**
 * One retention pass. Safe to run repeatedly; every step is idempotent.
 */
export async function runRetention(
  database: PrismaClient,
  options: { syncRunRetentionDays: number; now?: Date },
): Promise<RetentionSummary> {
  const now = options.now ?? new Date();
  const summary = emptySummary();

  summary.historyDeleted = await deleteExpiredHistory(database, now);

  const { accountsDeleted, deletionsOverdue } = await completePendingDeletions(
    database,
    now,
  );
  summary.accountsDeleted = accountsDeleted;
  summary.deletionsOverdue = deletionsOverdue;

  // Purge after both deletions, so metadata orphaned by either is caught.
  Object.assign(summary, await purgeOrphanedMetadata(database));

  // Sessions that can no longer authenticate anyone.
  summary.sessionsDeleted = (
    await database.appSession.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { idleAt: { lt: now } },
          { revokedAt: { lt: new Date(now.getTime() - 86_400_000) } },
        ],
      },
    })
  ).count;

  // OAuth state and rate-limit counters are short lived; the specification
  // calls for cleanup 24 hours after expiry.
  summary.oauthStatesDeleted = (
    await database.oAuthState.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } },
    })
  ).count;

  // Bounded operational audit, retained for the configured window.
  summary.syncRunsDeleted = (
    await database.syncRun.deleteMany({
      where: {
        startedAt: {
          lt: new Date(
            now.getTime() - options.syncRunRetentionDays * 86_400_000,
          ),
        },
      },
    })
  ).count;

  logger.info(
    { event: 'retention.completed', ...summary },
    'retention pass complete',
  );
  return summary;
}
