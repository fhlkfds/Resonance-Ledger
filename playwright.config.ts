import { defineConfig, devices } from '@playwright/test';

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  'postgresql://resonance:resonance-e2e-password-long@127.0.0.1:5432/resonance_e2e?schema=public';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
          },
        }
      : {}),
  },
  webServer: [
    {
      command: 'node tests/e2e/fake-provider.mjs',
      port: 4010,
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev',
      port: 3100,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        APP_URL: 'http://127.0.0.1:3100',
        PORT: '3100',
        HOST_PORT: '3100',
        BIND_ADDRESS: '127.0.0.1',
        POSTGRES_DB: 'resonance_e2e',
        POSTGRES_USER: 'resonance',
        POSTGRES_PASSWORD: 'resonance-e2e-password-long',
        DATABASE_URL: databaseUrl,
        EXTERNAL_DATABASE: 'true',
        SPOTIFY_CLIENT_ID: 'e2e-client-id',
        SPOTIFY_CLIENT_SECRET: 'e2e-client-secret-at-least-24-chars',
        SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:3100/api/auth/callback',
        SPOTIFY_ACCOUNTS_ORIGIN: 'http://127.0.0.1:4010',
        SPOTIFY_API_ORIGIN: 'http://127.0.0.1:4010',
        SESSION_SECRET: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
        TOKEN_ENCRYPTION_KEY: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=',
        TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
        SYNC_INTERVAL_SECONDS: '180',
        SYNC_OVERLAP_SECONDS: '300',
        DATA_RETENTION_DAYS: '730',
        SYNC_RUN_RETENTION_DAYS: '90',
        LOG_LEVEL: 'error',
        TRUST_PROXY: '0',
        TZ: 'UTC',
        APP_IMAGE: 'resonance-ledger',
        APP_VERSION: 'e2e',
        BACKUP_DIR: '/tmp/resonance-ledger-e2e-backups',
        BACKUP_RETENTION_DAYS: '30',
        BACKUP_BEFORE_DEPLOY: 'false',
      },
    },
  ],
  globalSetup: './tests/e2e/global-setup.ts',
});
