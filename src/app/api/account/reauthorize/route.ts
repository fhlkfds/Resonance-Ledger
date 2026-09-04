import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api/handler';
import { jsonResponse } from '@/lib/api/responses';
import { requireMutationSession } from '@/lib/auth/mutations';
import { oauthCookieName, secureCookieOptions } from '@/lib/auth/cookies';
import { generateOAuthState } from '@/lib/auth/oauth-state';
import { storeOAuthState } from '@/lib/auth/oauth-repository';
import { spotifyAuthorizationUrl } from '@/lib/auth/spotify-oauth';
import { database } from '@/lib/db/client';
import { getEnvironment } from '@/lib/env';

export async function POST(request: Request): Promise<NextResponse> {
  return apiHandler(request, async (requestId) => {
    const session = await requireMutationSession(request);
    const environment = getEnvironment();
    const production = environment.NODE_ENV === 'production';
    const state = generateOAuthState();
    await storeOAuthState(database, state, '/', session.userId);
    (await cookies()).set(
      oauthCookieName(production),
      state,
      secureCookieOptions(production, 600),
    );
    // The URL is built server-side and returned for the browser to follow;
    // a 302 here would be opaque to the fetch that initiated it.
    return jsonResponse(
      {
        authorizationUrl: spotifyAuthorizationUrl({
          clientId: environment.SPOTIFY_CLIENT_ID,
          redirectUri: environment.SPOTIFY_REDIRECT_URI,
          state,
        }),
      },
      requestId,
    );
  });
}
