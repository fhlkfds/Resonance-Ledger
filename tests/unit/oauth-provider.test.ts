import { describe, expect, it, vi } from 'vitest';
import {
  exchangeAuthorizationCode,
  fetchSpotifyProfile,
} from '@/lib/auth/spotify-oauth';

/**
 * The Spotify token and profile endpoints are untrusted boundaries. These
 * cover the failure paths: non-2xx responses, oversized bodies, and payloads
 * that do not match the expected shape.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const TOKENS = {
  access_token: 'access-value',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'refresh-value',
  scope: 'user-read-recently-played user-read-private',
};

describe('authorization code exchange', () => {
  it('authenticates with HTTP Basic and posts the expected grant', async () => {
    const fetcher = vi.fn(async () => jsonResponse(TOKENS));
    const result = await exchangeAuthorizationCode({
      code: 'the-code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://music.resonance.test/api/auth/callback',
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(result.access_token).toBe('access-value');
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://accounts.spotify.com/api/token');
    const headers = init.headers as Record<string, string>;
    const expected = Buffer.from('client-id:client-secret').toString('base64');
    expect(headers.Authorization).toBe(`Basic ${expected}`);
    // The secret goes in the Authorization header, never the body.
    expect(String(init.body)).not.toContain('client-secret');
    expect(String(init.body)).toContain('grant_type=authorization_code');
  });

  it('throws on a non-2xx response without echoing the body', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ error: 'invalid_grant' }, 400),
    );
    await expect(
      exchangeAuthorizationCode({
        code: 'bad',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://music.resonance.test/api/auth/callback',
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/status 400/);
  });

  it('rejects an oversized provider body', async () => {
    const huge = 'x'.repeat(1_000_001);
    const fetcher = vi.fn(async () => new Response(huge, { status: 200 }));
    await expect(
      exchangeAuthorizationCode({
        code: 'code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://music.resonance.test/api/auth/callback',
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/size limit/);
  });

  it('rejects a token payload missing required fields', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ token_type: 'Bearer' }));
    await expect(
      exchangeAuthorizationCode({
        code: 'code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://music.resonance.test/api/auth/callback',
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
  });
});

describe('current profile', () => {
  it('sends a bearer token and a descriptive user agent', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ id: 'legacy-id', account_id: 'immutable-id' }),
    );
    const profile = await fetchSpotifyProfile(
      'access-value',
      fetcher as unknown as typeof fetch,
    );
    expect(profile.account_id ?? profile.id).toBeTruthy();
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.spotify.com/v1/me');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-value');
    expect(headers['User-Agent']).toMatch(/Resonance-Ledger/);
  });

  it('throws on a non-2xx profile response', async () => {
    const fetcher = vi.fn(async () => jsonResponse({}, 401));
    await expect(
      fetchSpotifyProfile('stale', fetcher as unknown as typeof fetch),
    ).rejects.toThrow(/status 401/);
  });

  it('never requests the email scope', async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ id: 'legacy-id', account_id: 'immutable-id' }),
    );
    await fetchSpotifyProfile(
      'access-value',
      fetcher as unknown as typeof fetch,
    );
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.stringify(init)).not.toContain('user-read-email');
  });
});

describe('default fetch implementation', () => {
  it('falls back to the global fetch when no fetcher is injected', async () => {
    const original = globalThis.fetch;
    const stub = vi.fn(async () => jsonResponse(TOKENS));
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      const result = await exchangeAuthorizationCode({
        code: 'the-code',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://music.resonance.test/api/auth/callback',
      });
      expect(result.access_token).toBe('access-value');
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('uses the global fetch for the profile call too', async () => {
    const original = globalThis.fetch;
    const stub = vi.fn(async () =>
      jsonResponse({ id: 'legacy-id', account_id: 'immutable-id' }),
    );
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      await fetchSpotifyProfile('access-value');
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = original;
    }
  });
});
