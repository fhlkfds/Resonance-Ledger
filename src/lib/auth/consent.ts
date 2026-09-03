import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CONSENT_VERSION = '2026-09-03';
export const CONSENT_COOKIE = 'resonance_consent';
const CONSENT_TTL_SECONDS = 60 * 60;

function signature(payload: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(payload, 'utf8').digest();
}

export function createConsentReceipt(secret: Buffer, now = new Date()): string {
  const payload = `${CONSENT_VERSION}.${Math.floor(now.getTime() / 1000)}.${randomBytes(16).toString('base64url')}`;
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}

export function verifyConsentReceipt(
  value: string | undefined,
  secret: Buffer,
  now = new Date(),
): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  const [version, issuedText, nonce, encodedSignature] = parts;
  if (version !== CONSENT_VERSION || !nonce || !issuedText || !encodedSignature)
    return false;
  const issued = Number(issuedText);
  const age = Math.floor(now.getTime() / 1000) - issued;
  if (!Number.isSafeInteger(issued) || age < 0 || age > CONSENT_TTL_SECONDS)
    return false;
  const expected = signature(`${version}.${issuedText}.${nonce}`, secret);
  const actual = Buffer.from(encodedSignature, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
