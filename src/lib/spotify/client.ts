import {
  recentlyPlayedPageSchemaV1,
  spotifyArtistsSchema,
  spotifyTracksSchema,
  type SpotifyPlayedItem,
} from './schemas';

import { apiOrigin } from './endpoints';

const API_ORIGIN = apiOrigin();
const MAX_ATTEMPTS = 5;

export class SpotifyHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyHttpError';
  }
}

export function validateSpotifyNextUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== API_ORIGIN || url.protocol !== 'https:')
    throw new Error('Spotify pagination URL origin is not allowed');
  return url;
}

type ClientOptions = {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  onUnauthorized?: () => Promise<string>;
  requestId: string;
};

async function fetchWithPolicy(
  url: URL,
  token: string,
  options: ClientOptions,
): Promise<{ response: Response; token: string }> {
  const fetcher = options.fetcher ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  let activeToken = token;
  let refreshed = false;
  let transientAttempt = 0;

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
    } catch {
      transientAttempt += 1;
      if (transientAttempt >= MAX_ATTEMPTS)
        throw new SpotifyHttpError(0, 'Spotify request failed after retries');
      await sleep(
        Math.floor(
          random() * Math.min(60_000, 1_000 * 2 ** (transientAttempt - 1)),
        ),
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
      await sleep(retryAfter * 1000 + Math.floor(random() * 1001));
      continue;
    }
    if (response.status >= 500) {
      transientAttempt += 1;
      if (transientAttempt >= MAX_ATTEMPTS)
        throw new SpotifyHttpError(
          response.status,
          'Spotify service unavailable after retries',
        );
      await sleep(
        Math.floor(
          random() * Math.min(60_000, 1_000 * 2 ** (transientAttempt - 1)),
        ),
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
