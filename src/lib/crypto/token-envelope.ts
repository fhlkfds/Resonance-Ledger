import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const tokenEnvelopeSchema = z.object({
  version: z.string().regex(/^v[1-9]\d*$/),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
  tag: z.string().min(1),
});

export type TokenEnvelope = z.infer<typeof tokenEnvelopeSchema>;
export type TokenType = 'access' | 'refresh';

function aad(accountId: string, type: TokenType, version: string): Buffer {
  return Buffer.from(
    `resonance-ledger\0${accountId}\0${type}\0${version}`,
    'utf8',
  );
}

function validateKey(key: Buffer): void {
  if (key.length !== 32)
    throw new Error('Token encryption key must be exactly 32 bytes');
}

export function encryptToken(
  plaintext: string,
  context: { accountId: string; type: TokenType; version: string },
  key: Buffer,
): TokenEnvelope {
  validateKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(context.accountId, context.type, context.version));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return {
    version: context.version,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptToken(
  input: unknown,
  context: { accountId: string; type: TokenType },
  keys: ReadonlyMap<string, Buffer>,
): string {
  const envelope = tokenEnvelopeSchema.parse(input);
  const key = keys.get(envelope.version);
  if (!key) throw new Error('Token encryption key version is unavailable');
  validateKey(key);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.nonce, 'base64'),
  );
  decipher.setAAD(aad(context.accountId, context.type, envelope.version));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
