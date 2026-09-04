/**
 * Bounded batch re-encryption of stored token envelopes (§17).
 *
 * Rotating TOKEN_ENCRYPTION_KEY_VERSION alone does not move existing data:
 * envelopes keep the version they were written under. This job decrypts under
 * whichever key version an envelope names -- active or previous -- and writes
 * it back under the active version.
 *
 * Properties the runbook depends on:
 *
 * - Bounded. At most `batchSize` accounts per tick, so a large installation
 *   degrades into more ticks rather than one long transaction.
 * - Idempotent. An envelope already on the active version is skipped, so
 *   re-running is free and safe.
 * - Per-account. Each account is re-encrypted inside its own transaction
 *   under the same advisory lock the refresh path takes, so a concurrent
 *   token refresh cannot interleave with a rewrite.
 * - Fail-soft. An account whose envelope cannot be read (for instance the
 *   previous key was removed too early) is counted and skipped, never
 *   allowed to abort the whole pass.
 */
import type { PrismaClient } from '@prisma/client';
import {
  decryptToken,
  encryptToken,
  tokenEnvelopeSchema,
} from '@/lib/crypto/token-envelope';
import { activeTokenKey, tokenKeyMap } from '@/lib/crypto/key-map';
import type { Environment } from '@/lib/env';
import { logger } from '@/lib/observability/logger';

/** Accounts per tick. Small enough that a pass is always short. */
export const ROTATION_BATCH_SIZE = 50;

export type RotationSummary = {
  scanned: number;
  rotated: number;
  skipped: number;
  failed: number;
  /** Accounts still holding a non-active envelope version after this pass. */
  remaining: number;
};

type RotationEnvironment = Pick<
  Environment,
  | 'TOKEN_ENCRYPTION_KEY'
  | 'TOKEN_ENCRYPTION_KEY_VERSION'
  | 'TOKEN_ENCRYPTION_KEY_PREVIOUS'
  | 'TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION'
>;

function envelopeVersion(value: unknown): string | null {
  const parsed = tokenEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data.version : null;
}

export async function rotateTokenKeys(
  database: PrismaClient,
  environment: RotationEnvironment,
  options: { batchSize?: number } = {},
): Promise<RotationSummary> {
  const activeVersion = environment.TOKEN_ENCRYPTION_KEY_VERSION;
  const keys = tokenKeyMap(environment);
  const key = activeTokenKey(environment);
  const batchSize = Math.max(1, options.batchSize ?? ROTATION_BATCH_SIZE);
  const summary: RotationSummary = {
    scanned: 0,
    rotated: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
  };

  // JSON path comparison, so the batch is selected in the database rather
  // than by scanning every account into memory.
  const stale = await database.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM spotify_accounts
    WHERE access_token_envelope ->> 'version' <> ${activeVersion}
       OR refresh_token_envelope ->> 'version' <> ${activeVersion}
    ORDER BY id
    LIMIT ${batchSize}
  `;

  for (const { id: accountId } of stale) {
    summary.scanned += 1;
    try {
      const changed = await database.$transaction(async (transaction) => {
        // The same lock validAccessToken takes, so a refresh cannot write a
        // new envelope underneath this rewrite.
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`;
        const account = await transaction.spotifyAccount.findUnique({
          where: { id: accountId },
        });
        if (!account) return false;
        const accessStale =
          envelopeVersion(account.accessTokenEnvelope) !== activeVersion;
        const refreshStale =
          envelopeVersion(account.refreshTokenEnvelope) !== activeVersion;
        // Re-checked inside the lock: a refresh may already have rewritten it.
        if (!accessStale && !refreshStale) return false;

        const data: Record<string, unknown> = {};
        if (accessStale) {
          const plaintext = decryptToken(
            account.accessTokenEnvelope,
            { accountId, type: 'access' },
            keys,
          );
          data.accessTokenEnvelope = encryptToken(
            plaintext,
            { accountId, type: 'access', version: activeVersion },
            key,
          );
        }
        if (refreshStale) {
          const plaintext = decryptToken(
            account.refreshTokenEnvelope,
            { accountId, type: 'refresh' },
            keys,
          );
          data.refreshTokenEnvelope = encryptToken(
            plaintext,
            { accountId, type: 'refresh', version: activeVersion },
            key,
          );
        }
        await transaction.spotifyAccount.update({
          where: { id: accountId },
          data,
        });
        return true;
      });
      if (changed) summary.rotated += 1;
      else summary.skipped += 1;
    } catch (error) {
      // Most likely the previous key was removed before the rotation
      // finished. Never print the account's tokens or the key material.
      summary.failed += 1;
      logger.error(
        {
          event: 'token_key_rotation.account_failed',
          accountId,
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        },
        'could not re-encrypt an account token envelope',
      );
    }
  }

  const remainingRows = await database.$queryRaw<Array<{ remaining: bigint }>>`
    SELECT COUNT(*)::bigint AS remaining FROM spotify_accounts
    WHERE access_token_envelope ->> 'version' <> ${activeVersion}
       OR refresh_token_envelope ->> 'version' <> ${activeVersion}
  `;
  summary.remaining = Number(remainingRows[0]?.remaining ?? 0);

  logger.info(
    { event: 'token_key_rotation.completed', ...summary },
    'token key rotation pass complete',
  );
  return summary;
}
