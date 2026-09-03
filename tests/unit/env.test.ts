import { describe, expect, it } from 'vitest';
import { environmentSchema } from '@/lib/env';

const key = Buffer.alloc(32, 1).toString('base64');
const otherKey = Buffer.alloc(32, 2).toString('base64');

const validEnvironment = {
  NODE_ENV: 'production',
  APP_URL: 'https://listen.test',
  PORT: '3000',
  HOST_PORT: '3000',
  BIND_ADDRESS: '127.0.0.1',
  POSTGRES_DB: 'resonance',
  POSTGRES_USER: 'resonance',
  POSTGRES_PASSWORD: 'a-long-random-database-password',
  DATABASE_URL:
    'postgresql://resonance:password@postgres:5432/resonance?schema=public',
  SPOTIFY_CLIENT_ID: 'client-id',
  SPOTIFY_CLIENT_SECRET: 'a-long-random-client-secret',
  SPOTIFY_REDIRECT_URI: 'https://listen.test/api/auth/callback',
  SESSION_SECRET: key,
  TOKEN_ENCRYPTION_KEY: otherKey,
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
  BACKUP_DIR: '/tmp/resonance-backups',
  BACKUP_RETENTION_DAYS: '30',
  BACKUP_BEFORE_DEPLOY: 'true',
} as const;

describe('environmentSchema', () => {
  it('accepts a complete production environment', () => {
    expect(environmentSchema.parse(validEnvironment)).toMatchObject({
      PORT: 3000,
      DATA_RETENTION_DAYS: 730,
    });
  });

  it.each([
    ['placeholder', { SPOTIFY_CLIENT_SECRET: 'your_spotify_client_secret' }],
    ['equal secrets', { TOKEN_ENCRYPTION_KEY: key }],
    [
      'HTTP production URL',
      {
        APP_URL: 'http://listen.test',
        SPOTIFY_REDIRECT_URI: 'http://listen.test/api/auth/callback',
      },
    ],
    [
      'callback mismatch',
      { SPOTIFY_REDIRECT_URI: 'https://other.test/api/auth/callback' },
    ],
    ['short interval', { SYNC_INTERVAL_SECONDS: '59' }],
    ['short overlap', { SYNC_OVERLAP_SECONDS: '120' }],
    [
      'external database host',
      { DATABASE_URL: 'postgresql://user:password@db.example.test/resonance' },
    ],
  ])('rejects %s', (_name, change) => {
    expect(
      environmentSchema.safeParse({ ...validEnvironment, ...change }).success,
    ).toBe(false);
  });
});
