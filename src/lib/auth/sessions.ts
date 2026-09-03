import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { hashSecret } from './oauth-state';

export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_IDLE_SECONDS = 24 * 60 * 60;
export const RECENT_AUTH_SECONDS = 10 * 60;

export type NewSession = { token: string; csrfToken: string; expiresAt: Date };

export async function createSession(
  database: PrismaClient,
  userId: string,
  now = new Date(),
): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_SECONDS * 1000);
  await database.appSession.create({
    data: {
      userId,
      tokenHash: hashSecret(token),
      csrfHash: hashSecret(csrfToken),
      expiresAt,
      idleAt: new Date(now.getTime() + SESSION_IDLE_SECONDS * 1000),
      authAt: now,
    },
  });
  return { token, csrfToken, expiresAt };
}

export async function resolveSession(
  database: PrismaClient,
  token: string | undefined,
  now = new Date(),
) {
  if (!token) return null;
  return database.appSession.findFirst({
    where: {
      tokenHash: hashSecret(token),
      revokedAt: null,
      expiresAt: { gt: now },
      idleAt: { gt: now },
      user: { deletedAt: null, status: 'ACTIVE' },
    },
    include: { user: true },
  });
}

export async function revokeSession(
  database: PrismaClient,
  token: string | undefined,
  now = new Date(),
): Promise<void> {
  if (!token) return;
  await database.appSession.updateMany({
    where: { tokenHash: hashSecret(token), revokedAt: null },
    data: { revokedAt: now },
  });
}
