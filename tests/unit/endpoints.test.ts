import { describe, expect, it } from 'vitest';
import { accountsOrigin, apiOrigin } from '@/lib/spotify/endpoints';

/**
 * The provider origins exist only so an end-to-end test can put a fake OAuth
 * server in front of the boundary. The override must be impossible to abuse.
 */

describe('provider origins', () => {
  it('defaults to the real Spotify origins', () => {
    expect(accountsOrigin({ NODE_ENV: 'production' })).toBe(
      'https://accounts.spotify.com',
    );
    expect(apiOrigin({ NODE_ENV: 'production' })).toBe(
      'https://api.spotify.com',
    );
  });

  it('accepts a loopback override only under NODE_ENV=test', () => {
    expect(
      accountsOrigin({
        NODE_ENV: 'test',
        SPOTIFY_ACCOUNTS_ORIGIN: 'http://127.0.0.1:4010',
      }),
    ).toBe('http://127.0.0.1:4010');
    expect(
      apiOrigin({ NODE_ENV: 'test', SPOTIFY_API_ORIGIN: 'http://[::1]:4011' }),
    ).toBe('http://[::1]:4011');
  });

  it('refuses an override in development or production', () => {
    for (const nodeEnv of ['production', 'development']) {
      expect(() =>
        accountsOrigin({
          NODE_ENV: nodeEnv,
          SPOTIFY_ACCOUNTS_ORIGIN: 'http://127.0.0.1:4010',
        }),
      ).toThrow(/only be set when NODE_ENV is test/);
    }
  });

  it('refuses a non-loopback override even under test', () => {
    for (const hostile of [
      'http://evil.test',
      'https://attacker.example',
      'http://169.254.169.254',
      'http://localhost:4010',
      'http://127.0.0.1:4010/path',
      'http://127.0.0.1.evil.test:4010',
      'file:///etc/passwd',
    ]) {
      expect(() =>
        apiOrigin({ NODE_ENV: 'test', SPOTIFY_API_ORIGIN: hostile }),
        `expected ${hostile} to be refused`,
      ).toThrow(/loopback origin/);
    }
  });
});
