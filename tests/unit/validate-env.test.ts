import { describe, expect, it } from 'vitest';
import {
  parseEnvFile,
  validateEnvironment,
} from '../../scripts/validate-env.mjs';
import { environmentSchema } from '@/lib/env';

/**
 * scripts/validate-env.mjs runs before the application starts, so it cannot
 * import the Zod schema in src/lib/env.ts. The two therefore restate the same
 * rules. These tests hold them to the same verdicts so they cannot drift.
 */

const VALID: Record<string, string> = {
  NODE_ENV: 'production',
  APP_URL: 'https://music.resonance.test',
  PORT: '3000',
  HOST_PORT: '3000',
  BIND_ADDRESS: '127.0.0.1',
  POSTGRES_DB: 'resonance',
  POSTGRES_USER: 'resonance',
  POSTGRES_PASSWORD: 'sup3rSecretDatabasePassw0rdXY',
  DATABASE_URL:
    'postgresql://resonance:sup3rSecretDatabasePassw0rdXY@postgres:5432/resonance?schema=public',
  SPOTIFY_CLIENT_ID: '8f2c1d4e9a7b3c6d0e5f2a1b8c4d7e90',
  SPOTIFY_CLIENT_SECRET: 'b41d9f2ac7e358061bd42fa9e70c1583a6d4e2f9',
  SPOTIFY_REDIRECT_URI: 'https://music.resonance.test/api/auth/callback',
  SESSION_SECRET: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  TOKEN_ENCRYPTION_KEY: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=',
  TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
  SYNC_INTERVAL_SECONDS: '180',
  SYNC_OVERLAP_SECONDS: '300',
  DATA_RETENTION_DAYS: '730',
  SYNC_RUN_RETENTION_DAYS: '90',
  LOG_LEVEL: 'info',
  TRUST_PROXY: '1',
  TZ: 'UTC',
  APP_IMAGE: 'resonance-ledger',
  APP_VERSION: '0.1.0',
  BACKUP_DIR: '/var/backups/resonance-ledger',
  BACKUP_RETENTION_DAYS: '30',
  BACKUP_BEFORE_DEPLOY: 'true',
};

function omit(source: Record<string, string>, key: string) {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

const scriptAccepts = (env: Record<string, string>) =>
  validateEnvironment(env).length === 0;
const schemaAccepts = (env: Record<string, string>) =>
  environmentSchema.safeParse(env).success;

/** Cases both implementations must agree on. */
const CASES: [string, Record<string, string>, boolean][] = [
  ['a fully valid configuration', VALID, true],
  [
    'a placeholder password',
    { ...VALID, POSTGRES_PASSWORD: 'CHANGE_TO_RANDOM_VALUE' },
    false,
  ],
  [
    'a placeholder client id',
    { ...VALID, SPOTIFY_CLIENT_ID: 'your_spotify_client_id' },
    false,
  ],
  [
    'an example.com app url',
    { ...VALID, APP_URL: 'https://music.example.com' },
    false,
  ],
  [
    'plain HTTP in production',
    {
      ...VALID,
      APP_URL: 'http://music.resonance.test',
      SPOTIFY_REDIRECT_URI: 'http://music.resonance.test/api/auth/callback',
    },
    false,
  ],
  [
    'a callback on another origin',
    { ...VALID, SPOTIFY_REDIRECT_URI: 'https://evil.test/api/auth/callback' },
    false,
  ],
  [
    'a callback on the wrong path',
    {
      ...VALID,
      SPOTIFY_REDIRECT_URI: 'https://music.resonance.test/api/callback',
    },
    false,
  ],
  [
    'equal session and token keys',
    { ...VALID, TOKEN_ENCRYPTION_KEY: VALID.SESSION_SECRET! },
    false,
  ],
  [
    'a token key that is not 32 bytes',
    { ...VALID, TOKEN_ENCRYPTION_KEY: 'c2hvcnRrZXk=' },
    false,
  ],
  [
    'a sync interval below the floor',
    { ...VALID, SYNC_INTERVAL_SECONDS: '30' },
    false,
  ],
  [
    'a sync interval above the ceiling',
    { ...VALID, SYNC_INTERVAL_SECONDS: '901' },
    false,
  ],
  [
    'an overlap shorter than the interval',
    { ...VALID, SYNC_INTERVAL_SECONDS: '600', SYNC_OVERLAP_SECONDS: '120' },
    false,
  ],
  ['a non-integer port', { ...VALID, PORT: 'three thousand' }, false],
  ['an out-of-range trust proxy', { ...VALID, TRUST_PROXY: '99' }, false],
  [
    'a bad key version',
    { ...VALID, TOKEN_ENCRYPTION_KEY_VERSION: 'version-one' },
    false,
  ],
  [
    'a non-postgres database host',
    {
      ...VALID,
      DATABASE_URL:
        'postgresql://resonance:sup3rSecretDatabasePassw0rdXY@db.internal:5432/resonance',
    },
    false,
  ],
  [
    'an external database opt-in',
    {
      ...VALID,
      EXTERNAL_DATABASE: 'true',
      DATABASE_URL:
        'postgresql://resonance:sup3rSecretDatabasePassw0rdXY@db.internal:5432/resonance',
    },
    true,
  ],
  ['a latest app version', { ...VALID, APP_VERSION: 'latest' }, false],
  ['an unknown log level', { ...VALID, LOG_LEVEL: 'verbose' }, false],
  ['a missing required variable', omit(VALID, 'SESSION_SECRET'), false],
];

describe('validate-env.mjs agrees with the runtime schema', () => {
  for (const [name, env, expected] of CASES) {
    it(`${expected ? 'accepts' : 'rejects'} ${name}`, () => {
      expect(scriptAccepts(env), 'validate-env.mjs verdict').toBe(expected);
      expect(schemaAccepts(env), 'src/lib/env.ts verdict').toBe(expected);
    });
  }
});

describe('env file parsing', () => {
  it('reads assignments without evaluating them', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        '',
        'PLAIN=value',
        'QUOTED="quoted value"',
        "SINGLE='single value'",
        'export EXPORTED=exported',
        'WITH_EQUALS=postgresql://u:p@h:5432/d?schema=public',
        'INJECTION=$(touch /tmp/should-not-exist)',
      ].join('\n'),
    );
    expect(parsed.PLAIN).toBe('value');
    expect(parsed.QUOTED).toBe('quoted value');
    expect(parsed.SINGLE).toBe('single value');
    expect(parsed.EXPORTED).toBe('exported');
    expect(parsed.WITH_EQUALS).toBe('postgresql://u:p@h:5432/d?schema=public');
    // The value is captured as literal text, never executed.
    expect(parsed.INJECTION).toBe('$(touch /tmp/should-not-exist)');
  });
});

describe('validator output safety', () => {
  it('names the offending variable but never echoes its value', () => {
    const secret = 'sup3rSecretDatabasePassw0rdXY';
    const problems = validateEnvironment({
      ...VALID,
      SYNC_INTERVAL_SECONDS: '5',
      SPOTIFY_CLIENT_SECRET: 'Zq7Wm',
    });
    const text = problems.join('\n');
    expect(text).toContain('SYNC_INTERVAL_SECONDS');
    expect(text).toContain('SPOTIFY_CLIENT_SECRET');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(VALID.TOKEN_ENCRYPTION_KEY);
    // The rejected value itself must not be echoed back.
    expect(text).not.toContain('Zq7Wm');
  });
});
