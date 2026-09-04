import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { ProblemError } from './errors';
import { hashSecret } from '@/lib/auth/oauth-state';

export async function enforceRateLimit(
  database: PrismaClient,
  key: string,
  limit: number,
  windowSeconds: number,
  now = new Date(),
): Promise<void> {
  const rateKey = hashSecret(key);
  const retryAfter = await database.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${rateKey}, 0))`;
    const since = new Date(now.getTime() - windowSeconds * 1000);
    const entries = await transaction.oAuthState.findMany({
      where: {
        purpose: 'RATE',
        rateKey,
        createdAt: { gt: since },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    if (entries.length >= limit) {
      return Math.max(
        1,
        Math.ceil(
          (entries[0]!.createdAt.getTime() +
            windowSeconds * 1000 -
            now.getTime()) /
            1000,
        ),
      );
    }
    await transaction.oAuthState.create({
      data: {
        stateHash: hashSecret(randomBytes(32).toString('base64url')),
        purpose: 'RATE',
        rateKey,
        expiresAt: new Date(now.getTime() + windowSeconds * 1000),
        createdAt: now,
      },
    });
    return null;
  });
  if (retryAfter !== null) {
    const error = new ProblemError(
      429,
      'RATE_LIMITED',
      `Rate limit exceeded; retry after ${retryAfter} seconds`,
    );
    throw error;
  }
}

export function requestClientAddress(
  request: Request,
  trustProxy: number,
): string {
  if (trustProxy > 0) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]!.trim().slice(0, 64);
  }
  return request.headers.get('x-real-ip')?.slice(0, 64) || 'unknown';
}
