import {
  recentlyPlayedPageSchemaV1,
  spotifyArtistsSchema,
  spotifyTracksSchema,
  type SpotifyPlayedItem,
} from './schemas';

import { apiOrigin } from './endpoints';

const API_ORIGIN = apiOrigin();
const MAX_ATTEMPTS = 5;
/**
 * Ceiling on any single wait. A hostile or misconfigured `Retry-After: 86400`
 * would otherwise park the worker for a day while it holds a sync lease and
 * blocks the single-threaded scheduler.
 */
export const MAX_SLEEP_MS = 60_000;
/** 429s get their own budget so a persistent rate limit cannot loop forever. */
export const RATE_LIMIT_BUDGET = 3;

export class SpotifyHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyHttpError';
  }
}

/**
 * Raised when the run should stop and be retried later rather than keep
 * waiting: either the 429 budget is spent or Retry-After exceeds the sleep
 * ceiling. `retryAfterSeconds` is the remainder the caller should defer by.
 */
export class SpotifyRateLimitError extends SpotifyHttpError {
  constructor(
    readonly retryAfterSeconds: number,
    message: string,
  ) {
    super(429, message);
    this.name = 'SpotifyRateLimitError';
  }
}

/** Raised when the shutdown signal fires while the client is waiting. */
export class SpotifyAbortedError extends Error {
  constructor(message = 'Spotify request aborted by shutdown') {
    super(message);
    this.name = 'SpotifyAbortedError';
  }
}

export function validateSpotifyNextUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== API_ORIGIN || url.protocol !== 'https:')
    throw new Error('Spotify pagination URL origin is not allowed');
  return url;
}

export type ClientOptions = {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onUnauthorized?: () => Promise<string>;
  /**
   * Renews the sync lease. Called at every page boundary and before every
   * retry wait -- the points where a run can outlive its lease. Throwing here
   * aborts the run, which is how a lost lease stops work from being silently
   * discarded.
   */
  heartbeat?: () => Promise<void>;
  /** Shutdown signal; interrupts a wait so SIGTERM is not stuck behind it. */
  signal?: AbortSignal | undefined;
  requestId: string;
};

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Every wait in this module goes through here: it clamps to MAX_SLEEP_MS,
 * renews the lease first so a long wait cannot expire it, and turns an abort
 * into a thrown error instead of silently continuing after shutdown.
 */
async function waitBeforeRetry(
  milliseconds: number,
  options: ClientOptions,
): Promise<void> {
  if (options.signal?.aborted) throw new SpotifyAbortedError();
  await options.heartbeat?.();
  const sleep = options.sleep ?? defaultSleep;
  await sleep(
    Math.min(MAX_SLEEP_MS, Math.max(0, Math.floor(milliseconds))),
    options.signal,
  );
  if (options.signal?.aborted) throw new SpotifyAbortedError();
}

async function fetchWithPolicy(
  url: URL,
  token: string,
  options: ClientOptions,
): Promise<{ response: Response; token: string }> {
  const fetcher = options.fetcher ?? fetch;
  const random = options.random ?? Math.random;
  let activeToken = token;
  let refreshed = false;
  let transientAttempt = 0;
  let rateLimitAttempt = 0;

  while (true) {
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          Authorization: `Bearer ${activeToken}`,
          Accept: 'application/json',
          'User-Agent': 'Resonance-Ledger/0.1',
          'X-Request-ID': options.requestId,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (error instanceof SpotifyAbortedError) throw error;
      transientAttempt += 1;
      if (transientAttempt >= MAX_ATTEMPTS)
        throw new SpotifyHttpError(0, 'Spotify request failed after retries');
      await waitBeforeRetry(
        random() * Math.min(MAX_SLEEP_MS, 1_000 * 2 ** (transientAttempt - 1)),
        options,
      );
      continue;
    }

    if (response.status === 401 && options.onUnauthorized && !refreshed) {
      activeToken = await options.onUnauthorized();
      refreshed = true;
      continue;
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      if (!Number.isFinite(retryAfter) || retryAfter < 0)
        throw new SpotifyHttpError(
          429,
          'Spotify rate limit omitted valid Retry-After',
        );
      // Honour Retry-After, but never in-process beyond the ceiling: hand the
      // remainder back so the caller defers the run instead of sleeping on a
      // held lease.
      if (retryAfter * 1000 > MAX_SLEEP_MS)
        throw new SpotifyRateLimitError(
          retryAfter,
          'Spotify Retry-After exceeds the in-process wait ceiling',
        );
      rateLimitAttempt += 1;
      if (rateLimitAttempt > RATE_LIMIT_BUDGET)
        throw new SpotifyRateLimitError(
          retryAfter,
          'Spotify rate limit budget exhausted for this run',
        );
      await waitBeforeRetry(
        retryAfter * 1000 + Math.floor(random() * 1001),
        options,
      );
      continue;
    }
    if (response.status >= 500) {
      transientAttempt += 1;
      if (transientAttempt >= MAX_ATTEMPTS)
        throw new SpotifyHttpError(
          response.status,
          'Spotify service unavailable after retries',
        );
      await waitBeforeRetry(
        random() * Math.min(MAX_SLEEP_MS, 1_000 * 2 ** (transientAttempt - 1)),
        options,
      );
      continue;
    }
    if (!response.ok)
      throw new SpotifyHttpError(
        response.status,
        `Spotify request rejected with status ${response.status}`,
      );
    return { response, token: activeToken };
  }
}

export async function fetchRecentlyPlayed(
  accessToken: string,
  afterMilliseconds: number,
  options: ClientOptions,
): Promise<{
  items: SpotifyPlayedItem[];
  pagesFetched: number;
  bounded: boolean;
}> {
  let url: URL | null = new URL('/v1/me/player/recently-played', API_ORIGIN);
  url.search = new URLSearchParams({
    limit: '50',
    after: String(Math.max(0, afterMilliseconds)),
  }).toString();
  const items: SpotifyPlayedItem[] = [];
  let pagesFetched = 0;
  let token = accessToken;
  let bounded = false;

  while (url && pagesFetched < 10 && items.length < 500) {
    const result = await fetchWithPolicy(url, token, options);
    token = result.token;
    const text = await result.response.text();
    if (text.length > 2_000_000)
      throw new Error('Spotify recently-played payload exceeds size limit');
    const page = recentlyPlayedPageSchemaV1.parse(JSON.parse(text));
    items.push(...page.items);
    pagesFetched += 1;
    url = page.next ? validateSpotifyNextUrl(page.next) : null;
    if ((pagesFetched === 10 || items.length >= 500) && url) bounded = true;
    // A ten-page walk with retries can outlast the 120s lease. Renew it at
    // each boundary; a lost lease throws and aborts the run.
    if (url) await options.heartbeat?.();
    if (options.signal?.aborted) throw new SpotifyAbortedError();
  }
  items.sort(
    (left, right) => Date.parse(left.played_at) - Date.parse(right.played_at),
  );
  return { items: items.slice(0, 500), pagesFetched, bounded };
}

export async function fetchSpotifyMetadata(
  accessToken: string,
  trackIds: string[],
  options: ClientOptions,
) {
  if (trackIds.length < 1 || trackIds.length > 50)
    throw new RangeError('Metadata refresh requires 1 to 50 track IDs');
  const tracksUrl = new URL('/v1/tracks', API_ORIGIN);
  tracksUrl.searchParams.set('ids', trackIds.join(','));
  const tracksResponse = await fetchWithPolicy(tracksUrl, accessToken, options);
  const tracksText = await tracksResponse.response.text();
  if (tracksText.length > 2_000_000)
    throw new Error('Spotify track metadata payload exceeds size limit');
  const tracks = spotifyTracksSchema.parse(JSON.parse(tracksText)).tracks;
  const artistIds = [
    ...new Set(
      tracks.flatMap(
        (track) =>
          track?.artists.flatMap((artist) => (artist.id ? [artist.id] : [])) ??
          [],
      ),
    ),
  ].slice(0, 50);
  if (!artistIds.length) return { tracks, artists: [] };
  const artistsUrl = new URL('/v1/artists', API_ORIGIN);
  artistsUrl.searchParams.set('ids', artistIds.join(','));
  const artistsResponse = await fetchWithPolicy(
    artistsUrl,
    tracksResponse.token,
    options,
  );
  const artistsText = await artistsResponse.response.text();
  if (artistsText.length > 2_000_000)
    throw new Error('Spotify artist metadata payload exceeds size limit');
  return {
    tracks,
    artists: spotifyArtistsSchema.parse(JSON.parse(artistsText)).artists,
  };
}
