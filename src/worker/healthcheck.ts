/**
 * Container health probe for the worker service.
 *
 * Verifies database reachability and that this worker has recorded a recent
 * heartbeat. It makes no Spotify call, so provider outages do not mark the
 * container unhealthy.
 *
 * A worker with no leased account never heartbeats, which is a healthy idle
 * state, so an absent heartbeat is only a failure when sync state exists and
 * every row is stale.
 */
import { PrismaClient } from '@prisma/client';

/** Three worker ticks (30s each) plus the two-minute lease ceiling. */
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

const database = new PrismaClient();

try {
  await database.$queryRaw`SELECT 1`;

  const running = await database.syncState.count({
    where: { status: 'RUNNING' },
  });
  if (running > 0) {
    const fresh = await database.syncState.count({
      where: {
        status: 'RUNNING',
        workerHeartbeatAt: { gt: new Date(Date.now() - HEARTBEAT_STALE_MS) },
      },
    });
    if (fresh === 0) {
      console.error('worker heartbeat is stale for every running account');
      process.exitCode = 1;
    }
  }
} catch {
  console.error('worker health check could not reach the database');
  process.exitCode = 1;
} finally {
  await database.$disconnect();
}
