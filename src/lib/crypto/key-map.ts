import type { Environment } from '@/lib/env';

/**
 * The decryption key map for stored token envelopes.
 *
 * §17 requires reading a superseded key version while the rotation job
 * re-encrypts envelopes under the active one. A single-entry map made
 * rotation impossible: the moment TOKEN_ENCRYPTION_KEY_VERSION advanced to
 * v2, every stored v1 envelope threw "Token encryption key version is
 * unavailable" and every account was bricked.
 */
export function tokenKeyMap(
  environment: Pick<
    Environment,
    | 'TOKEN_ENCRYPTION_KEY'
    | 'TOKEN_ENCRYPTION_KEY_VERSION'
    | 'TOKEN_ENCRYPTION_KEY_PREVIOUS'
    | 'TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION'
  >,
): Map<string, Buffer> {
  const keys = new Map<string, Buffer>([
    [
      environment.TOKEN_ENCRYPTION_KEY_VERSION,
      Buffer.from(environment.TOKEN_ENCRYPTION_KEY, 'base64'),
    ],
  ]);
  const previousKey = environment.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  const previousVersion = environment.TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION;
  // env.ts rejects a mismatched pair and a previous version equal to the
  // active one, so this cannot shadow the active key.
  if (previousKey && previousVersion)
    keys.set(previousVersion, Buffer.from(previousKey, 'base64'));
  return keys;
}

/** The key new envelopes are written under. */
export function activeTokenKey(
  environment: Pick<Environment, 'TOKEN_ENCRYPTION_KEY'>,
): Buffer {
  return Buffer.from(environment.TOKEN_ENCRYPTION_KEY, 'base64');
}
