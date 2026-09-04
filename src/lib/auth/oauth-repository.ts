import type { PrismaClient } from '@prisma/client';
import { CONSENT_VERSION } from './consent';
import { hashSecret, OAUTH_STATE_TTL_SECONDS } from './oauth-state';

export async function storeOAuthState(
  database: PrismaClient,
  rawState: string,
  returnPath: string,
  userId?: string,
  now = new Date(),
): Promise<void> {
  await database.oAuthState.create({
    data: {
      stateHash: hashSecret(rawState),
      returnPath,
      ...(userId ? { userId } : {}),
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000),
    },
  });
}

export async function consumeOAuthState(
  database: PrismaClient,
  rawState: string,
  now = new Date(),
) {
  return database.$transaction(async (transaction) => {
    const state = await transaction.oAuthState.findUnique({
      where: { stateHash: hashSecret(rawState) },
    });
    if (
      !state ||
      state.purpose !== 'OAUTH' ||
      state.usedAt ||
      state.expiresAt <= now
    )
      return null;
    const result = await transaction.oAuthState.updateMany({
      where: { id: state.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    return result.count === 1 ? state : null;
  });
}

export async function createConsentedUser(
  database: PrismaClient,
  now = new Date(),
) {
  return database.user.create({
    data: {
      status: 'ACTIVE',
      consentVersion: CONSENT_VERSION,
      consentedAt: now,
      settings: { create: {} },
    },
  });
}
