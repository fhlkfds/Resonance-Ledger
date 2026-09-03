import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { CONSENT_COOKIE, verifyConsentReceipt } from '@/lib/auth/consent';
import { oauthCookieName, secureCookieOptions } from '@/lib/auth/cookies';
import { generateOAuthState, safeReturnPath } from '@/lib/auth/oauth-state';
import { storeOAuthState } from '@/lib/auth/oauth-repository';
import { spotifyAuthorizationUrl } from '@/lib/auth/spotify-oauth';
import { database } from '@/lib/db/client';
import { getEnvironment } from '@/lib/env';

export async function GET(request: Request): Promise<NextResponse> {
  const environment = getEnvironment();
  const store = await cookies();
  if (
    !verifyConsentReceipt(
      store.get(CONSENT_COOKIE)?.value,
      Buffer.from(environment.SESSION_SECRET, 'base64'),
    )
  ) {
    return NextResponse.redirect(
      new URL('/login?error=consent_required', environment.APP_URL),
      302,
    );
  }
  const state = generateOAuthState();
  const returnPath = safeReturnPath(
    new URL(request.url).searchParams.get('returnTo'),
  );
  await storeOAuthState(database, state, returnPath);
  store.set(oauthCookieName(environment.NODE_ENV === 'production'), state, {
    ...secureCookieOptions(environment.NODE_ENV === 'production', 600),
  });
  return NextResponse.redirect(
    spotifyAuthorizationUrl({
      clientId: environment.SPOTIFY_CLIENT_ID,
      redirectUri: environment.SPOTIFY_REDIRECT_URI,
      state,
    }),
    302,
  );
}
