import { z } from 'zod';
import { accountsOrigin, apiOrigin } from '@/lib/spotify/endpoints';

export const SPOTIFY_SCOPES = [
  'user-read-recently-played',
  'user-read-private',
] as const;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string(),
});

/**
 * Spotify returns the immutable user key on /v1/me as `id`. `account_id` is
 * not part of that body; it is accepted only as an alias so fixtures and
 * proxies that emit the older name keep parsing. A body carrying neither key
 * fails closed.
 */
const profileSchema = z
  .object({
    id: z.string().min(1).optional(),
    account_id: z.string().min(1).optional(),
    display_name: z.string().nullable().optional(),
  })
  .passthrough()
  .refine((profile) => Boolean(profile.id ?? profile.account_id), {
    message: 'Spotify profile is missing the account key',
    path: ['id'],
  });

export type SpotifyTokenResponse = z.infer<typeof tokenResponseSchema>;
export type SpotifyProfile = z.infer<typeof profileSchema>;

/** The immutable provider key to store as `spotifyAccountId`. */
export function spotifyAccountKey(profile: SpotifyProfile): string {
  const key = profile.id ?? profile.account_id;
  if (!key) throw new Error('Spotify profile is missing the account key');
  return key;
}

export function spotifyAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): URL {
  const url = new URL(`${accountsOrigin()}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: SPOTIFY_SCOPES.join(' '),
    state: input.state,
  }).toString();
  return url;
}

async function providerJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 1_000_000)
    throw new Error('Spotify response exceeds size limit');
  return JSON.parse(text) as unknown;
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetcher?: typeof fetch;
}): Promise<SpotifyTokenResponse> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(`${accountsOrigin()}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `Spotify token exchange failed with status ${response.status}`,
    );
  return tokenResponseSchema.parse(await providerJson(response));
}

export async function fetchSpotifyProfile(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<SpotifyProfile> {
  const response = await fetcher(`${apiOrigin()}/v1/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Resonance-Ledger/0.1',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`Spotify profile failed with status ${response.status}`);
  return profileSchema.parse(await providerJson(response));
}
