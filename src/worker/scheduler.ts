import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Environment } from '@/lib/env';
import { leaseNextDueAccount } from '@/lib/db/repositories/sync';
import { syncLeasedAccount } from './sync-account';

export async function runScheduler(
  database: PrismaClient,
  environment: Environment,
  signal: AbortSignal,
): Promise<void> {
  const workerId = randomUUID();
  while (!signal.aborted) {
    const lease = await leaseNextDueAccount(database, workerId);
    if (lease)
      await syncLeasedAccount(
        database,
        lease.spotifyAccountId,
        workerId,
        environment,
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
