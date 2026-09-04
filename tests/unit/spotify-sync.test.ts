import { describe, expect, it, vi } from 'vitest';
import {
  fetchRecentlyPlayed,
  SpotifyHttpError,
  validateSpotifyNextUrl,
} from '@/lib/spotify/client';
import { normalizePlayedItem } from '@/lib/spotify/normalize';
import { recentlyPlayedPageSchemaV1 } from '@/lib/spotify/schemas';
import { recentlyPlayedPage, spotifyItem } from '../fixtures/spotify';

describe('Spotify normalization', () => {
  it('preserves artist order and partial release precision', () => {
    const normalized = normalizePlayedItem(spotifyItem());
    expect(normalized.track.artists.map((artist) => artist.spotifyId)).toEqual([
      'artist-1',
      'artist-2',
    ]);
    expect(normalized.track.album).toMatchObject({
      releaseDateText: '2026-09',
      releaseDatePrecision: 'month',
      releaseYear: 2026,
      artworkUrl: null,
    });
    expect(normalized.estimatedDurationMs).toBe(180_000);
  });

  it('makes a deterministic local key from the specified fields', () => {
    const local = spotifyItem({
      track: {
        ...spotifyItem().track,
        id: null,
        uri: null,
        is_local: true,
        external_ids: {},
        album: null,
      },
    });
    const first = normalizePlayedItem(local);
    const second = normalizePlayedItem(structuredClone(local));
    expect(first.track.externalKey).toMatch(/^local:[0-9a-f]{64}$/);
    expect(first.track.externalKey).toBe(second.track.externalKey);
    expect(first.track.isLocal).toBe(true);
  });

  it('tolerates unknown optional fields but rejects a missing played_at', () => {
    expect(
      recentlyPlayedPageSchemaV1.safeParse({
        ...recentlyPlayedPage([spotifyItem()]),
        future_optional: true,
      }).success,
    ).toBe(true);
    const malformed = recentlyPlayedPage([
      { track: spotifyItem().track } as never,
    ]);
    expect(recentlyPlayedPageSchemaV1.safeParse(malformed).success).toBe(false);
  });
});

describe('Spotify recently-played client', () => {
  it('rejects pagination outside the exact API origin', () => {
    expect(
      validateSpotifyNextUrl('https://api.spotify.com/v1/next').origin,
    ).toBe('https://api.spotify.com');
    expect(() =>
      validateSpotifyNextUrl('https://api.spotify.com.evil.test/v1/next'),
    ).toThrow();
    expect(() =>
      validateSpotifyNextUrl('http://api.spotify.com/v1/next'),
    ).toThrow();
  });

  it('follows valid pages and sorts events ascending', async () => {
    const later = spotifyItem({ played_at: '2026-09-03T12:02:00.000Z' });
    const earlier = spotifyItem({ played_at: '2026-09-03T12:01:00.000Z' });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            recentlyPlayedPage([later], 'https://api.spotify.com/v1/next'),
          ),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(recentlyPlayedPage([earlier])), {
          status: 200,
        }),
      );
    const result = await fetchRecentlyPlayed('token', 1000, {
      fetcher,
      requestId: 'request',
    });
    expect(result.pagesFetched).toBe(2);
    expect(result.items.map((item) => item.played_at)).toEqual([
      earlier.played_at,
      later.played_at,
    ]);
    expect(String(fetcher.mock.calls[0]![0])).toContain('limit=50&after=1000');
  });

  it('honors Retry-After plus bounded jitter before retrying', async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(
      async () => undefined,
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': '2' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(recentlyPlayedPage([])), { status: 200 }),
      );
    await fetchRecentlyPlayed('token', 0, {
      fetcher,
      sleep,
      random: () => 0.5,
      requestId: 'request',
    });
    expect(sleep).toHaveBeenCalledWith(2500);
  });

  it('retries 5xx with capped full jitter and stops after five attempts', async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(
      async () => undefined,
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 503 }));
    await expect(
      fetchRecentlyPlayed('token', 0, {
        fetcher,
        sleep,
        random: () => 0.5,
        requestId: 'request',
      }),
    ).rejects.toBeInstanceOf(SpotifyHttpError);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      500, 1000, 2000, 4000,
    ]);
  });

  it('refreshes once for 401 and retries with the replacement token', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(recentlyPlayedPage([])), { status: 200 }),
      );
    const onUnauthorized = vi.fn(async () => 'replacement-token');
    await fetchRecentlyPlayed('old-token', 0, {
      fetcher,
      onUnauthorized,
      requestId: 'request',
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect((fetcher.mock.calls[1]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer replacement-token',
    });
  });
});
