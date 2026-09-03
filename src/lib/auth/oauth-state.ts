import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function safeReturnPath(value: string | null | undefined): string {
  if (
    !value ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//')
  )
    return '/';
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const parsed = new URL(value, 'https://resonance-ledger.invalid');
    return parsed.origin === 'https://resonance-ledger.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : '/';
  } catch {
    return '/';
  }
}
