import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Environment } from '@/lib/env';
import { leaseNextDueAccount } from '@/lib/db/repositories/sync';
import { logger } from '@/lib/observability/logger';
import { runRetention } from './retention';
import { syncLeasedAccount } from './sync-account';
import { refreshMetadata } from './metadata-refresh';

/** Retention runs once a day; the tick loop just checks whether it is due. */
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const METADATA_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function runScheduler(
  database: PrismaClient,
  environment: Environment,
  signal: AbortSignal,
): Promise<void> {
  const workerId = randomUUID();
  // Run one pass shortly after start so a long-stopped installation catches up
  // without waiting a full day.
  let retentionDueAt = Date.now();
  let metadataDueAt = Date.now();

  while (!signal.aborted) {
    if (Date.now() >= retentionDueAt) {
      try {
        await runRetention(database, {
          syncRunRetentionDays: environment.SYNC_RUN_RETENTION_DAYS,
        });
      } catch (error) {
        // A failed retention pass must not stop synchronization; the next
        // pass retries, and the failure is operator-visible in the logs.
        logger.error(
          {
            event: 'retention.failed',
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          },
          'retention pass failed and will be retried',
        );
      }
      retentionDueAt = Date.now() + RETENTION_INTERVAL_MS;
    }

    if (Date.now() >= metadataDueAt) {
      try {
        await refreshMetadata(database, environment);
      } catch (error) {
        logger.error(
          {
            event: 'metadata_refresh.failed',
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          },
          'metadata refresh failed and will be retried',
        );
      }
      metadataDueAt = Date.now() + METADATA_INTERVAL_MS;
    }

    const lease = await leaseNextDueAccount(database, workerId);
    if (lease)
      await syncLeasedAccount(
        database,
        lease.spotifyAccountId,
        workerId,
        environment,
        signal,
      );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
