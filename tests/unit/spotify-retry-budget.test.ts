import { describe, expect, it, vi } from 'vitest';
import {
  fetchRecentlyPlayed,
  MAX_SLEEP_MS,
  RATE_LIMIT_BUDGET,
  SpotifyAbortedError,
  SpotifyRateLimitError,
} from '@/lib/spotify/client';
import { recentlyPlayedPage, spotifyItem } from '../fixtures/spotify';

/**
 * H4: Retry-After was honoured with no ceiling and no attempt counter, so a
 * hostile `Retry-After: 86400` parked the worker for a day while holding a
 * sync lease, and a persistent 429 looped forever.
 */

const tooManyRequests = (retryAfter: string) =>
  new Response('', { status: 429, headers: { 'Retry-After': retryAfter } });

const okPage = () =>
  new Response(JSON.stringify(recentlyPlayedPage([spotifyItem()])), {
    status: 200,
  });

const noSleep = () =>
  vi.fn<(milliseconds: number, signal?: AbortSignal) => Promise<void>>(
    async () => undefined,
  );

describe('429 handling', () => {
  it('defers instead of sleeping when Retry-After exceeds the ceiling', async () => {
    const sleep = noSleep();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(tooManyRequests('86400'));
    const error = await fetchRecentlyPlayed('token', 0, {
      fetcher,
      sleep,
      random: () => 0.5,
      requestId: 'request',
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SpotifyRateLimitError);
    expect((error as SpotifyRateLimitError).retryAfterSeconds).toBe(86400);
    // The whole point: no 24h wait on a held lease.
    expect(sleep).not.toHaveBeenCalled();
  });

  it('never sleeps longer than the ceiling', async () => {
    const sleep = noSleep();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tooManyRequests('60'))
      .mockResolvedValueOnce(okPage());
    await fetchRecentlyPlayed('token', 0, {
      fetcher,
      sleep,
      random: () => 1,
      requestId: 'request',
    });
    for (const [milliseconds] of sleep.mock.calls)
      expect(milliseconds).toBeLessThanOrEqual(MAX_SLEEP_MS);
  });

  it('stops after the 429 budget instead of looping forever', async () => {
    const sleep = noSleep();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(tooManyRequests('1'));
    await expect(
      fetchRecentlyPlayed('token', 0, {
        fetcher,
        sleep,
        random: () => 0,
        requestId: 'request',
      }),
    ).rejects.toBeInstanceOf(SpotifyRateLimitError);
    // Budget waits, then one more 429 that exhausts it.
    expect(fetcher).toHaveBeenCalledTimes(RATE_LIMIT_BUDGET + 1);
    expect(sleep).toHaveBeenCalledTimes(RATE_LIMIT_BUDGET);
  });

  it('recovers normally within the budget', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tooManyRequests('1'))
      .mockResolvedValueOnce(tooManyRequests('1'))
      .mockResolvedValueOnce(okPage());
    const result = await fetchRecentlyPlayed('token', 0, {
      fetcher,
      sleep: noSleep(),
      random: () => 0,
      requestId: 'request',
    });
    expect(result.items).toHaveLength(1);
  });
});

describe('shutdown during a wait', () => {
  it('aborts rather than continuing after the signal fires', async () => {
    const controller = new AbortController();
    const sleep = vi.fn(async () => {
      controller.abort();
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(tooManyRequests('1'));
    await expect(
      fetchRecentlyPlayed('token', 0, {
        fetcher,
        sleep,
        random: () => 0,
        signal: controller.signal,
        requestId: 'request',
      }),
    ).rejects.toBeInstanceOf(SpotifyAbortedError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('threads the signal into the injected sleep so a wait is interruptible', async () => {
    const controller = new AbortController();
    const sleep = noSleep();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tooManyRequests('1'))
      .mockResolvedValueOnce(okPage());
    await fetchRecentlyPlayed('token', 0, {
      fetcher,
      sleep,
      random: () => 0,
      signal: controller.signal,
      requestId: 'request',
    });
    expect(sleep.mock.calls[0]![1]).toBe(controller.signal);
  });

  it('does not start a request when already aborted mid-retry', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(tooManyRequests('1'));
    await expect(
      fetchRecentlyPlayed('token', 0, {
        fetcher,
        sleep: noSleep(),
        random: () => 0,
        signal: controller.signal,
        requestId: 'request',
      }),
    ).rejects.toBeInstanceOf(SpotifyAbortedError);
  });
});
