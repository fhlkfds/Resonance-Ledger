import { PrismaClient } from '@prisma/client';

const globalDatabase = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Defaults for the two limits §18 requires. Both are deliberately read
 * straight from process.env rather than through the full environment schema:
 * this module is imported by every route, and `next build` must not need a
 * complete production configuration to trace them.
 */
const DEFAULT_POOL_SIZE = 10;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Bound the pool and cap statement runtime.
 *
 * Without a `connection_limit` Prisma sizes the pool from the CPU count, so a
 * burst of expensive reads can open more connections than PostgreSQL's
 * max_connections allows. Without a `statement_timeout` a single heavy query
 * runs until it or the server dies, holding its connection the whole time --
 * which is exactly how one authenticated request turned into a denial of
 * service. `options` is passed through to libpq by the PostgreSQL connector.
 */
export function databaseUrlWithLimits(
  databaseUrl: string,
  environment: Partial<Record<string, string>> = process.env,
): string {
  const poolSize = positiveInteger(
    environment.DATABASE_POOL_SIZE,
    DEFAULT_POOL_SIZE,
  );
  const statementTimeoutMs = positiveInteger(
    environment.DATABASE_STATEMENT_TIMEOUT_MS,
    DEFAULT_STATEMENT_TIMEOUT_MS,
  );
  const url = new URL(databaseUrl);
  // An operator who has set these explicitly keeps their value.
  if (!url.searchParams.has('connection_limit'))
    url.searchParams.set('connection_limit', String(poolSize));
  if (!url.searchParams.has('pool_timeout'))
    url.searchParams.set('pool_timeout', '10');
  if (!url.searchParams.has('options'))
    url.searchParams.set(
      'options',
      `-c statement_timeout=${statementTimeoutMs}`,
    );
  return url.toString();
}

function createClient(): PrismaClient {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return new PrismaClient();
  return new PrismaClient({
    datasources: { db: { url: databaseUrlWithLimits(databaseUrl) } },
  });
}

export const database = globalDatabase.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalDatabase.prisma = database;
}
