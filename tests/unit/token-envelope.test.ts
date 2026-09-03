import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from '@/lib/crypto/token-envelope';

describe('AES-256-GCM token envelope', () => {
  const key = randomBytes(32);
  const keys = new Map([['v1', key]]);
  const context = {
    accountId: 'account-1',
    type: 'access' as const,
    version: 'v1',
  };

  it('round trips only with the correct authenticated context', () => {
    const envelope = encryptToken('provider-token', context, key);
    expect(
      decryptToken(envelope, { accountId: 'account-1', type: 'access' }, keys),
    ).toBe('provider-token');
    expect(() =>
      decryptToken(envelope, { accountId: 'account-2', type: 'access' }, keys),
    ).toThrow();
    expect(() =>
      decryptToken(envelope, { accountId: 'account-1', type: 'refresh' }, keys),
    ).toThrow();
  });

  it('uses a unique 96-bit nonce for every envelope', () => {
    const nonces = new Set(
      Array.from(
        { length: 1_000 },
        () => encryptToken('same', context, key).nonce,
      ),
    );
    expect(nonces.size).toBe(1_000);
    expect(Buffer.from([...nonces][0]!, 'base64').length).toBe(12);
  });

  it('rejects tampering, unknown key versions, and invalid keys', () => {
    const envelope = encryptToken('provider-token', context, key);
    expect(() =>
      decryptToken(
        { ...envelope, ciphertext: Buffer.from('tampered').toString('base64') },
        context,
        keys,
      ),
    ).toThrow();
    expect(() =>
      decryptToken({ ...envelope, version: 'v2' }, context, keys),
    ).toThrow();
    expect(() =>
      encryptToken('provider-token', context, randomBytes(16)),
    ).toThrow();
  });
});
