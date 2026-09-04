/**
 * Spotify endpoint origins.
 *
 * These default to the real Spotify origins and are only overridable so an
 * end-to-end test can stand a fake provider in front of the OAuth boundary.
 *
 * The override is deliberately narrow. It is refused unless NODE_ENV is
 * `test`, and the value must be a loopback HTTP origin with no path, so this
 * cannot be turned into an SSRF primitive by a leaked or hostile environment.
 */

export const SPOTIFY_ACCOUNTS_ORIGIN = 'https://accounts.spotify.com';
export const SPOTIFY_API_ORIGIN = 'https://api.spotify.com';

/** Loopback literals only; never a hostname that could resolve outward. */
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}$/;

function overrideOrigin(
  variable: string,
  productionValue: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = environment[variable];
  if (!candidate) return productionValue;

  // A test-only escape hatch must never apply to a deployed installation.
  if (environment.NODE_ENV !== 'test') {
    throw new Error(`${variable} may only be set when NODE_ENV is test`);
  }
  if (!LOOPBACK_ORIGIN.test(candidate)) {
    throw new Error(`${variable} must be a loopback origin such as http://127.0.0.1:4010`);
  }
  return candidate;
}

/** Origin serving /authorize and /api/token. */
export function accountsOrigin(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return overrideOrigin(
    'SPOTIFY_ACCOUNTS_ORIGIN',
    SPOTIFY_ACCOUNTS_ORIGIN,
    environment,
  );
}

/** Origin serving /v1/me and /v1/me/player/recently-played. */
export function apiOrigin(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return overrideOrigin('SPOTIFY_API_ORIGIN', SPOTIFY_API_ORIGIN, environment);
}
