import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createConsentReceipt, verifyConsentReceipt } from '@/lib/auth/consent';
import {
  generateOAuthState,
  hashSecret,
  safeReturnPath,
  secretsEqual,
} from '@/lib/auth/oauth-state';
import {
  exchangeAuthorizationCode,
  fetchSpotifyProfile,
  spotifyAuthorizationUrl,
} from '@/lib/auth/spotify-oauth';

describe('OAuth state', () => {
  it('generates 10,000 unique 256-bit values and hashes them', () => {
    const states = Array.from({ length: 10_000 }, generateOAuthState);
    expect(new Set(states).size).toBe(10_000);
    expect(
      states.every((state) => Buffer.from(state, 'base64url').length === 32),
    ).toBe(true);
    expect(hashSecret(states[0]!)).not.toContain(states[0]!);
  });

  it.each([
    ['https://evil.test', '/'],
    ['//evil.test/path', '/'],
    ['/\\evil', '/'],
    ['/history?range=LAST_7_DAYS', '/history?range=LAST_7_DAYS'],
  ])('normalizes return path %s', (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });

  it('compares state without accepting unequal lengths', () => {
    expect(secretsEqual('same', 'same')).toBe(true);
    expect(secretsEqual('same', 'different')).toBe(false);
  });
});

describe('consent receipt', () => {
  it('accepts a current signed receipt and rejects tampering or expiry', () => {
    const secret = randomBytes(32);
    const now = new Date('2026-09-03T12:00:00.000Z');
    const receipt = createConsentReceipt(secret, now);
    expect(verifyConsentReceipt(receipt, secret, now)).toBe(true);
    expect(verifyConsentReceipt(`${receipt}x`, secret, now)).toBe(false);
    expect(
      verifyConsentReceipt(
        receipt,
        secret,
        new Date(now.getTime() + 3_601_000),
      ),
    ).toBe(false);
  });
});

describe('Spotify OAuth boundary', () => {
  it('builds the exact redirect and minimum scopes without email', () => {
    const url = spotifyAuthorizationUrl({
      clientId: 'client',
      redirectUri: 'https://listen.test/api/auth/callback',
      state: 'state',
    });
    expect(url.origin + url.pathname).toBe(
      'https://accounts.spotify.com/authorize',
    );
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://listen.test/api/auth/callback',
    );
    expect(url.searchParams.get('scope')).toBe(
      'user-read-recently-played user-read-private',
    );
    expect(url.toString()).not.toContain('user-read-email');
  });

  it('keeps authorization code and tokens in server requests only', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access-secret',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-secret',
          scope: 'user-read-private',
        }),
        { status: 200 },
      ),
    );
    const tokens = await exchangeAuthorizationCode({
      code: 'authorization-code',
      clientId: 'client',
      clientSecret: 'client-secret',
      redirectUri: 'https://listen.test/api/auth/callback',
      fetcher,
    });
    expect(tokens.access_token).toBe('access-secret');
    const request = fetcher.mock.calls[0]!;
    expect(request[0]).toBe('https://accounts.spotify.com/api/token');
    expect(String((request[1] as RequestInit).body)).toContain(
      'code=authorization-code',
    );
  });

  it('links from immutable account_id', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          account_id: 'immutable-account',
          id: 'deprecated-id',
          display_name: 'Listener',
        }),
        { status: 200 },
      ),
    );
    await expect(
      fetchSpotifyProfile('access-secret', fetcher),
    ).resolves.toMatchObject({ account_id: 'immutable-account' });
  });
});
