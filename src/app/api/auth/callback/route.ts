import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { encryptToken, tokenEnvelopeSchema } from '@/lib/crypto/token-envelope';
import { CONSENT_VERSION } from '@/lib/auth/consent';
import {
  oauthCookieName,
  secureCookieOptions,
  sessionCookieName,
} from '@/lib/auth/cookies';
import {
  consumeOAuthState,
  createConsentedUser,
} from '@/lib/auth/oauth-repository';
import { secretsEqual } from '@/lib/auth/oauth-state';
import { createSession } from '@/lib/auth/sessions';
import {
  exchangeAuthorizationCode,
  fetchSpotifyProfile,
  SPOTIFY_SCOPES,
} from '@/lib/auth/spotify-oauth';
import { database } from '@/lib/db/client';
import { getEnvironment } from '@/lib/env';

function loginError(
  environment: ReturnType<typeof getEnvironment>,
  code: string,
): NextResponse {
  return NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(code)}`, environment.APP_URL),
    302,
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  const environment = getEnvironment();
  const production = environment.NODE_ENV === 'production';
  const cookieStore = await cookies();
  const url = new URL(request.url);
  const queryState = url.searchParams.get('state');
  const cookieState = cookieStore.get(oauthCookieName(production))?.value;
  cookieStore.delete(oauthCookieName(production));

  if (url.searchParams.has('error'))
    return loginError(environment, 'spotify_denied');
  const code = url.searchParams.get('code');
  if (
    !code ||
    !queryState ||
    !cookieState ||
    !secretsEqual(queryState, cookieState)
  ) {
    return loginError(environment, 'invalid_state');
  }
  const state = await consumeOAuthState(database, queryState);
  if (!state) return loginError(environment, 'invalid_state');

  try {
    const tokens = await exchangeAuthorizationCode({
      code,
      clientId: environment.SPOTIFY_CLIENT_ID,
      clientSecret: environment.SPOTIFY_CLIENT_SECRET,
      redirectUri: environment.SPOTIFY_REDIRECT_URI,
    });
    const profile = await fetchSpotifyProfile(tokens.access_token);
    const now = new Date();
    const user = state.userId
      ? await database.user.findUniqueOrThrow({ where: { id: state.userId } })
      : await createConsentedUser(database, now);
    const key = Buffer.from(environment.TOKEN_ENCRYPTION_KEY, 'base64');
    const existing = await database.spotifyAccount.findUnique({
      where: { spotifyAccountId: profile.account_id },
    });
    if (existing && existing.userId !== user.id)
      return loginError(environment, 'account_already_linked');
    const accountId = existing?.id ?? crypto.randomUUID();
    const accessEnvelope = encryptToken(
      tokens.access_token,
      {
        accountId,
        type: 'access',
        version: environment.TOKEN_ENCRYPTION_KEY_VERSION,
      },
      key,
    );
    const refreshToken = tokens.refresh_token;
    if (!refreshToken && !existing)
      return loginError(environment, 'missing_refresh_token');
    const refreshEnvelope = refreshToken
      ? encryptToken(
          refreshToken,
          {
            accountId,
            type: 'refresh',
            version: environment.TOKEN_ENCRYPTION_KEY_VERSION,
          },
          key,
        )
      : tokenEnvelopeSchema.parse(existing!.refreshTokenEnvelope);
    await database.spotifyAccount.upsert({
      where: { spotifyAccountId: profile.account_id },
      create: {
        id: accountId,
        userId: user.id,
        spotifyAccountId: profile.account_id,
        displayName: profile.display_name ?? null,
        accessTokenEnvelope: accessEnvelope,
        refreshTokenEnvelope: refreshEnvelope,
        accessTokenExpiresAt: new Date(
          now.getTime() + tokens.expires_in * 1000,
        ),
        refreshTokenExpiresAt: new Date(
          now.getTime() + 183 * 24 * 60 * 60 * 1000,
        ),
        scopes: SPOTIFY_SCOPES.slice(),
        authorizedAt: now,
        syncState: { create: {} },
      },
      update: {
        displayName: profile.display_name ?? null,
        accessTokenEnvelope: accessEnvelope,
        refreshTokenEnvelope: refreshEnvelope,
        accessTokenExpiresAt: new Date(
          now.getTime() + tokens.expires_in * 1000,
        ),
        refreshTokenExpiresAt: new Date(
          now.getTime() + 183 * 24 * 60 * 60 * 1000,
        ),
        scopes: SPOTIFY_SCOPES.slice(),
        state: 'ACTIVE',
        authorizedAt: now,
      },
    });
    if (!user.consentedAt) {
      await database.user.update({
        where: { id: user.id },
        data: { consentVersion: CONSENT_VERSION, consentedAt: now },
      });
    }
    const session = await createSession(database, user.id, now);
    cookieStore.set(sessionCookieName(production), session.token, {
      ...secureCookieOptions(production, 30 * 24 * 60 * 60),
      expires: session.expiresAt,
    });
    return NextResponse.redirect(
      new URL(state.returnPath ?? '/', environment.APP_URL),
      302,
    );
  } catch {
    return loginError(environment, 'oauth_failed');
  }
}
