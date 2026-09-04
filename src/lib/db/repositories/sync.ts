import type { PrismaClient } from '@prisma/client';

export type LeasedAccount = {
  spotifyAccountId: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
};

export async function leaseNextDueAccount(
  database: PrismaClient,
  workerId: string,
  now = new Date(),
): Promise<LeasedAccount | null> {
  const rows = await database.$queryRaw<LeasedAccount[]>`
    WITH candidate AS (
      SELECT ss.spotify_account_id
      FROM sync_state ss
      JOIN spotify_accounts sa ON sa.id = ss.spotify_account_id
      WHERE sa.state = 'ACTIVE'::"AccountState"
        AND ss.status IN ('IDLE'::"SyncStatus", 'BACKOFF'::"SyncStatus", 'RUNNING'::"SyncStatus")
        AND ss.next_sync_at <= ${now}
        AND (ss.lease_expires_at IS NULL OR ss.lease_expires_at <= ${now})
      ORDER BY ss.next_sync_at, ss.spotify_account_id
      FOR UPDATE OF ss SKIP LOCKED
      LIMIT 1
    )
    UPDATE sync_state ss
    SET status = 'RUNNING'::"SyncStatus",
        lease_owner = ${workerId},
        lease_expires_at = ${new Date(now.getTime() + 120_000)},
        worker_heartbeat_at = ${now},
        last_attempt_at = ${now}
    FROM candidate
    WHERE ss.spotify_account_id = candidate.spotify_account_id
    RETURNING ss.spotify_account_id AS "spotifyAccountId", ss.lease_owner AS "leaseOwner", ss.lease_expires_at AS "leaseExpiresAt"
  `;
  return rows[0] ?? null;
}

export async function heartbeatLease(
  database: PrismaClient,
  accountId: string,
  workerId: string,
  now = new Date(),
): Promise<boolean> {
  const result = await database.syncState.updateMany({
    where: {
      spotifyAccountId: accountId,
      leaseOwner: workerId,
      leaseExpiresAt: { gt: now },
    },
    data: {
      workerHeartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + 120_000),
    },
  });
  return result.count === 1;
}

export async function queueManualSync(
  database: PrismaClient,
  userId: string,
  now = new Date(),
): Promise<'queued' | 'limited' | 'missing'> {
  return database.$transaction(async (transaction) => {
    const account = await transaction.spotifyAccount.findFirst({
      where: { userId, state: 'ACTIVE' },
      include: { syncState: true },
    });
    if (!account?.syncState) return 'missing';
    if (
      account.syncState.lastManualSyncAt &&
      account.syncState.lastManualSyncAt > new Date(now.getTime() - 60_000)
    )
      return 'limited';
    await transaction.syncState.update({
      where: { spotifyAccountId: account.id },
      data: { nextSyncAt: now, lastManualSyncAt: now },
    });
    return 'queued';
  });
}
