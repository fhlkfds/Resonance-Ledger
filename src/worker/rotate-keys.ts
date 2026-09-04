/**
 * One-shot token key rotation entry point (§17).
 *
 * Re-encrypts stored token envelopes under the active key version, in bounded
 * batches, until none remain. Safe to interrupt and safe to re-run: each
 * account is rotated in its own transaction and an envelope already on the
 * active version is skipped.
 *
 * Usage: node dist/worker/rotate-keys.mjs
 * Exit codes: 0 nothing left to rotate, 1 some accounts could not be read.
 *
 * See docs/runbooks/token-key-rotation.md.
 */
import { database } from '@/lib/db/client';
import { getEnvironment } from '@/lib/env';
import { logger } from '@/lib/observability/logger';
import { rotateTokenKeys } from './key-rotation';

const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => controller.abort());
}

try {
  const environment = getEnvironment();
  let failed = 0;
  for (;;) {
    if (controller.signal.aborted) {
      logger.warn(
        { event: 'token_key_rotation.interrupted' },
        'rotation interrupted; re-run to continue',
      );
      break;
    }
    const summary = await rotateTokenKeys(database, environment);
    failed += summary.failed;
    // No progress and nothing left, or nothing left to attempt: done.
    if (summary.remaining === 0) break;
    // Every account in the batch failed, so another pass would loop forever.
    if (summary.rotated === 0 && summary.skipped === 0) {
      logger.error(
        { event: 'token_key_rotation.stalled', remaining: summary.remaining },
        'rotation made no progress; check that the previous key is still set',
      );
      break;
    }
  }
  process.exitCode = failed > 0 ? 1 : 0;
} catch (error) {
  logger.error(
    {
      event: 'token_key_rotation.failed',
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    },
    'token key rotation stopped unexpectedly',
  );
  process.exitCode = 1;
} finally {
  await database.$disconnect();
}
