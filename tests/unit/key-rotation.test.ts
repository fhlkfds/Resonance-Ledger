import { describe, expect, it } from 'vitest';
import { environmentSchema } from '@/lib/env';
import { activeTokenKey, tokenKeyMap } from '@/lib/crypto/key-map';
import { decryptToken, encryptToken } from '@/lib/crypto/token-envelope';

/**
 * H6: access-token.ts built a single-entry key map, so §17 rotation was
 * impossible. The moment TOKEN_ENCRYPTION_KEY_VERSION advanced to v2, every
 * stored v1 envelope threw "Token encryption key version is unavailable" and
 * every account was bricked.
 */

const activeKey = Buffer.alloc(32, 1);
const previousKey = Buffer.alloc(32, 2);
const sessionSecret = Buffer.alloc(32, 3);

const baseEnvironment = {
  NODE_ENV: 'test',
  APP_URL: 'https://listen.test',
  PORT: '3000',
  POSTGRES_DB: 'resonance',
  POSTGRES_USER: 'resonance',
  POSTGRES_PASSWORD: 'unit-test-database-password',
  DATABASE_URL: 'postgresql://resonance:password@postgres:5432/resonance',
  SPOTIFY_CLIENT_ID: 'client-id',
  SPOTIFY_CLIENT_SECRET: 'unit-test-client-secret-long',
  SPOTIFY_REDIRECT_URI: 'https://listen.test/api/auth/callback',
  SESSION_SECRET: sessionSecret.toString('base64'),
  TOKEN_ENCRYPTION_KEY: activeKey.toString('base64'),
  TOKEN_ENCRYPTION_KEY_VERSION: 'v2',
  SYNC_INTERVAL_SECONDS: '180',
  SYNC_OVERLAP_SECONDS: '300',
  DATA_RETENTION_DAYS: '730',
  TRUST_PROXY: '1',
  APP_VERSION: 'test',
};

const parse = (overrides: Record<string, string> = {}) =>
  environmentSchema.safeParse({ ...baseEnvironment, ...overrides });

describe('token key map', () => {
  it('reads an envelope written under the previous key version', () => {
    const environment = parse({
      TOKEN_ENCRYPTION_KEY_PREVIOUS: previousKey.toString('base64'),
      TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: 'v1',
    });
    expect(environment.success).toBe(true);
    const old = encryptToken(
      'legacy-refresh-token',
      { accountId: 'account-1', type: 'refresh', version: 'v1' },
      previousKey,
    );
    expect(
      decryptToken(
        old,
        { accountId: 'account-1', type: 'refresh' },
        tokenKeyMap(environment.data!),
      ),
    ).toBe('legacy-refresh-token');
  });

  it('still reads envelopes on the active version', () => {
    const environment = parse({
      TOKEN_ENCRYPTION_KEY_PREVIOUS: previousKey.toString('base64'),
      TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: 'v1',
    }).data!;
    const current = encryptToken(
      'current-token',
      { accountId: 'account-1', type: 'access', version: 'v2' },
      activeTokenKey(environment),
    );
    expect(
      decryptToken(
        current,
        { accountId: 'account-1', type: 'access' },
        tokenKeyMap(environment),
      ),
    ).toBe('current-token');
  });

  it('holds only the active key when no previous key is configured', () => {
    const keys = tokenKeyMap(parse().data!);
    expect([...keys.keys()]).toEqual(['v2']);
  });

  it('bricks a v1 envelope when the previous key is absent', () => {
    // This is the pre-fix behaviour, and the reason the runbook insists the
    // old key stays set until rotation reports zero remaining.
    const old = encryptToken(
      'legacy',
      { accountId: 'account-1', type: 'refresh', version: 'v1' },
      previousKey,
    );
    expect(() =>
      decryptToken(
        old,
        { accountId: 'account-1', type: 'refresh' },
        tokenKeyMap(parse().data!),
      ),
    ).toThrow(/key version is unavailable/);
  });
});

describe('previous key validation', () => {
  it('rejects a previous key without its version', () => {
    const result = parse({
      TOKEN_ENCRYPTION_KEY_PREVIOUS: previousKey.toString('base64'),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a previous version without its key', () => {
    expect(parse({ TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: 'v1' }).success).toBe(
      false,
    );
  });

  it('rejects a previous version equal to the active version', () => {
    const result = parse({
      TOKEN_ENCRYPTION_KEY_PREVIOUS: previousKey.toString('base64'),
      TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: 'v2',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a previous key equal to the active key', () => {
    const result = parse({
      TOKEN_ENCRYPTION_KEY_PREVIOUS: activeKey.toString('base64'),
      TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: 'v1',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed rotation pair', () => {
    const result = parse({
      TOKEN_ENCRYPTION_KEY_PREVIOUS: previousKey.toString('base64'),
      TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: 'v1',
    });
    expect(result.success).toBe(true);
  });
});
