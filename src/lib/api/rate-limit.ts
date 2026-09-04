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

/**
 * Bucket shared by every request whose true address cannot be established.
 * Falling back here throttles a group of callers together, which is the safe
 * direction; falling back to a client-supplied value would hand an attacker a
 * fresh bucket per forged header and void the limit entirely.
 */
export const SHARED_ADDRESS_BUCKET = 'untrusted-shared';

/** IPv4, IPv6, and bracketed/ported forms. Anything else is not an address. */
const ADDRESS_PATTERN = /^\[?[0-9a-fA-F:.]{3,45}\]?(?::\d{1,5})?$/;

function usableAddress(value: string | null | undefined): string | null {
  const trimmed = value?.trim().slice(0, 64);
  if (!trimmed || !ADDRESS_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve the address to key a rate limit on.
 *
 * `TRUST_PROXY` is the number of reverse-proxy hops this deployment operates.
 * Those hops *append* to X-Forwarded-For, so the entry this installation can
 * vouch for sits that many places from the right-hand end. Everything to its
 * left was supplied by the caller and is forgeable, which is why the leftmost
 * entry must never be used: one header would otherwise buy an unlimited
 * supply of distinct buckets.
 *
 * `socketAddress` is the peer address of the connection when the runtime can
 * supply it. Next route handlers cannot, so callers usually pass nothing and
 * the untrusted cases collapse onto SHARED_ADDRESS_BUCKET.
 */
export function requestClientAddress(
  request: Request,
  trustProxy: number,
  socketAddress?: string | null,
): string {
  const socket = usableAddress(socketAddress);
  // TRUST_PROXY=0 means no proxy is trusted, so neither X-Forwarded-For nor
  // X-Real-IP carries any authority -- both are wholly attacker-controlled.
  if (trustProxy <= 0) return socket ?? SHARED_ADDRESS_BUCKET;

  const hops = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // A header shorter than the trusted hop count cannot have been written by
  // our own proxies, so none of it is attributable.
  if (hops.length < trustProxy) return socket ?? SHARED_ADDRESS_BUCKET;
  return usableAddress(hops[hops.length - trustProxy]) ?? SHARED_ADDRESS_BUCKET;
}
