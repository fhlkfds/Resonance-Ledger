import type { PrismaClient } from '@prisma/client';
import {
  decryptToken,
  encryptToken,
  tokenEnvelopeSchema,
} from '@/lib/crypto/token-envelope';
import type { Environment } from '@/lib/env';
import { InvalidGrantError, requestTokenRefresh } from './tokens';

export async function validAccessToken(
  database: PrismaClient,
  accountId: string,
  environment: Environment,
  now = new Date(),
): Promise<string> {
  const keys = new Map([
    [
      environment.TOKEN_ENCRYPTION_KEY_VERSION,
      Buffer.from(environment.TOKEN_ENCRYPTION_KEY, 'base64'),
    ],
  ]);
  const result = await database.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`;
      const account = await transaction.spotifyAccount.findUniqueOrThrow({
        where: { id: accountId },
      });
      const access = decryptToken(
        account.accessTokenEnvelope,
        { accountId, type: 'access' },
        keys,
      );
      if (account.accessTokenExpiresAt.getTime() > now.getTime() + 300_000)
        return { token: access };
      const refresh = decryptToken(
        account.refreshTokenEnvelope,
        { accountId, type: 'refresh' },
        keys,
      );
      if (account.refreshTokenExpiresAt <= now) {
        await transaction.spotifyAccount.update({
          where: { id: accountId },
          data: { state: 'NEEDS_REAUTH' },
        });
        await transaction.syncState.update({
          where: { spotifyAccountId: accountId },
          data: {
            status: 'NEEDS_REAUTH',
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        return { reauth: true as const };
      }
      try {
        const response = await requestTokenRefresh({
          refreshToken: refresh,
          clientId: environment.SPOTIFY_CLIENT_ID,
          clientSecret: environment.SPOTIFY_CLIENT_SECRET,
        });
        const key = keys.get(environment.TOKEN_ENCRYPTION_KEY_VERSION)!;
        const refreshEnvelope = response.refresh_token
          ? encryptToken(
              response.refresh_token,
              {
                accountId,
                type: 'refresh',
                version: environment.TOKEN_ENCRYPTION_KEY_VERSION,
              },
              key,
            )
          : tokenEnvelopeSchema.parse(account.refreshTokenEnvelope);
        await transaction.spotifyAccount.update({
          where: { id: accountId },
          data: {
            accessTokenEnvelope: encryptToken(
              response.access_token,
              {
                accountId,
                type: 'access',
                version: environment.TOKEN_ENCRYPTION_KEY_VERSION,
              },
              key,
            ),
            refreshTokenEnvelope: refreshEnvelope,
            accessTokenExpiresAt: new Date(
              now.getTime() + response.expires_in * 1000,
            ),
          },
        });
        return { token: response.access_token };
      } catch (error) {
        if (error instanceof InvalidGrantError) {
          await transaction.spotifyAccount.update({
            where: { id: accountId },
            data: { state: 'NEEDS_REAUTH' },
          });
          await transaction.syncState.update({
            where: { spotifyAccountId: accountId },
            data: {
              status: 'NEEDS_REAUTH',
              leaseOwner: null,
              leaseExpiresAt: null,
            },
          });
        }
        if (error instanceof InvalidGrantError)
          return { reauth: true as const };
        throw error;
      }
    },
    { timeout: 30_000 },
  );
  if ('reauth' in result) throw new InvalidGrantError();
  return result.token;
}
