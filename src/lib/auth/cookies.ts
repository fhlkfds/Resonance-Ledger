import type { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';

export function sessionCookieName(production: boolean): string {
  return production ? '__Host-resonance_session' : 'resonance_session';
}

export function oauthCookieName(production: boolean): string {
  return production ? '__Host-resonance_oauth_state' : 'resonance_oauth_state';
}

export function secureCookieOptions(
  production: boolean,
  maxAge: number,
): Partial<ResponseCookie> {
  return {
    httpOnly: true,
    secure: production,
    sameSite: 'lax',
    path: '/',
    maxAge,
  };
}
