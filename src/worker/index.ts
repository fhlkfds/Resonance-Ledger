import { database } from '@/lib/db/client';
import { getEnvironment } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import { runScheduler } from './scheduler';

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => controller.abort());
}

try {
  await runScheduler(database, getEnvironment(), controller.signal);
} catch (error) {
  logger.error(
    { errorClass: error instanceof Error ? error.name : 'UnknownError' },
    'worker stopped unexpectedly',
  );
  process.exitCode = 1;
} finally {
  await database.$disconnect();
}
