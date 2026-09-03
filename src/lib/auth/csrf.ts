import { hashSecret, secretsEqual } from './oauth-state';

export function validateSameOrigin(request: Request, appUrl: string): boolean {
  const expected = new URL(appUrl).origin;
  const origin = request.headers.get('origin');
  if (!origin || origin !== expected) return false;
  const host = request.headers.get('host');
  return host === new URL(expected).host;
}

export function validateCsrfToken(
  supplied: string | null,
  storedHash: string,
): boolean {
  return Boolean(supplied && secretsEqual(hashSecret(supplied), storedHash));
}
