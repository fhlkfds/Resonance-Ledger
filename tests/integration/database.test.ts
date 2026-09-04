import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EntityRepository } from '@/lib/db/repositories/entities';
import { HistoryRepository } from '@/lib/db/repositories/history';
import {
  consumeOAuthState,
  storeOAuthState,
} from '@/lib/auth/oauth-repository';
import {
  createSession,
  resolveSession,
  revokeSession,
} from '@/lib/auth/sessions';
import {
  heartbeatLease,
  leaseNextDueAccount,
} from '@/lib/db/repositories/sync';
import {
  LEASE_LOST_ERROR_CLASS,
  persistSyncBatch,
  recordSyncFailure,
} from '@/lib/spotify/persist';
import { syncLeasedAccount } from '@/worker/sync-account';
import { validAccessToken } from '@/lib/spotify/access-token';
import { decryptToken, encryptToken } from '@/lib/crypto/token-envelope';
import { parseEnvironment } from '@/lib/env';
import { ApiRepository } from '@/lib/db/repositories/api';
import { assertOwnedEntityFilters } from '@/lib/api/ownership';
import { decodeCursor, encodeCursor } from '@/lib/api/pagination';
import { dashboardData, rankedEntities } from '@/lib/stats/queries';
import { entityDetailData } from '@/lib/stats/entity-details';
import { analyticsData } from '@/lib/stats/analytics';
import { runRetention } from '@/worker/retention';
import { resolveRange } from '@/lib/stats/dates';
import { enforceRateLimit } from '@/lib/api/rate-limit';
import { disconnectUser } from '@/lib/db/repositories/disconnect';
import { databaseUrlWithLimits } from '@/lib/db/client';
import { spotifyItem } from '../fixtures/spotify';

let container: StartedPostgreSqlContainer;
let database: PrismaClient;

function migrate(databaseUrl: string): string {
  return execFileSync('./node_modules/.bin/prisma', ['migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('resonance_test')
    .withUsername('resonance')
    .withPassword('integration-test-only')
    .start();

  const databaseUrl = container.getConnectionUri();
  expect(migrate(databaseUrl)).toContain('1 migration');
  expect(migrate(databaseUrl)).toContain('No pending migrations');
  database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
});

afterAll(async () => {
  await database?.$disconnect();
  await container?.stop();
});

describe('initial PostgreSQL migration', () => {
  it('creates the 13 specified tables and native constraints', async () => {
    const tables = await database.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    expect(tables.map(({ table_name: name }) => name)).toEqual([
      '_prisma_migrations',
      'album_artists',
      'albums',
      'app_sessions',
      'artists',
      'listening_history',
      'oauth_states',
      'spotify_accounts',
      'sync_runs',
      'sync_state',
      'track_artists',
      'tracks',
      'user_settings',
      'users',
    ]);

    const user = await database.user.create({ data: { status: 'ACTIVE' } });
    await expect(
      database.userSettings.create({
        data: {
          userId: user.id,
          timezone: 'UTC',
          weekStartsOn: 7,
          retentionDays: 730,
        },
      }),
    ).rejects.toThrow();

    await expect(
      database.track.create({
        data: {
          externalKey: 'wrong:key',
          spotifyId: 'track-id',
          name: 'Bad key',
          normalizedName: 'bad key',
          durationMs: 1,
          metadataFetchedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});

describe('connection limits (§18)', () => {
  /**
   * H5/M9: a statement_timeout is what stops one heavy read from holding a
   * connection until the server gives up. Asserting the setting reached
   * PostgreSQL also pins the `options` passthrough we rely on.
   */
  it('enforces the configured statement_timeout on a real connection', async () => {
    const url = databaseUrlWithLimits(container.getConnectionUri(), {
      DATABASE_STATEMENT_TIMEOUT_MS: '2500',
      DATABASE_POOL_SIZE: '4',
    });
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      const shown = await client.$queryRaw<
        Array<{ statement_timeout: string }>
      >`SHOW statement_timeout`;
      // PostgreSQL echoes the setting back in its own units.
      expect(shown[0]!.statement_timeout).toBe('2500ms');
      // And it is actually enforced, not merely reported.
      await expect(client.$queryRaw`SELECT pg_sleep(5)`).rejects.toThrow();
    } finally {
      await client.$disconnect();
    }
  });
});

describe('database ownership and deletion', () => {
  it('enforces dedupe, user-scoped reads, and user cascades', async () => {
    const [userA, userB] = await Promise.all([
      database.user.create({ data: { status: 'ACTIVE' } }),
      database.user.create({ data: { status: 'ACTIVE' } }),
    ]);
    const envelope = {
      version: 'v1',
      ciphertext: 'fixture',
      nonce: 'fixture',
      tag: 'fixture',
    };
    const expiry = new Date('2027-01-01T00:00:00.000Z');
    const [accountA, accountB] = await Promise.all([
      database.spotifyAccount.create({
        data: {
          userId: userA.id,
          spotifyAccountId: 'spotify-account-a',
          accessTokenEnvelope: envelope,
          refreshTokenEnvelope: envelope,
          accessTokenExpiresAt: expiry,
          refreshTokenExpiresAt: expiry,
          scopes: ['user-read-private', 'user-read-recently-played'],
          syncState: { create: {} },
        },
      }),
      database.spotifyAccount.create({
        data: {
          userId: userB.id,
          spotifyAccountId: 'spotify-account-b',
          accessTokenEnvelope: envelope,
          refreshTokenEnvelope: envelope,
          accessTokenExpiresAt: expiry,
          refreshTokenExpiresAt: expiry,
          scopes: ['user-read-private', 'user-read-recently-played'],
        },
      }),
    ]);
    const track = await database.track.create({
      data: {
        externalKey: 'spotify:track-one',
        spotifyId: 'track-one',
        name: 'One',
        normalizedName: 'one',
        durationMs: 180_000,
        metadataFetchedAt: new Date(),
      },
    });
    const playedAt = new Date('2026-09-03T12:00:00.000Z');

    const first = await database.listeningHistory.createMany({
      data: [
        {
          spotifyAccountId: accountA.id,
          trackId: track.id,
          playedAt,
          estimatedDurationMs: 180_000,
        },
      ],
      skipDuplicates: true,
    });
    const replay = await database.listeningHistory.createMany({
      data: [
        {
          spotifyAccountId: accountA.id,
          trackId: track.id,
          playedAt,
          estimatedDurationMs: 180_000,
        },
      ],
      skipDuplicates: true,
    });
    expect([first.count, replay.count]).toEqual([1, 0]);

    const history = new HistoryRepository(database);
    const entities = new EntityRepository(database);
    expect(await history.countForUser(userA.id)).toBe(1);
    expect(await history.countForUser(userB.id)).toBe(0);
    expect(await entities.findTrackForUser(userA.id, track.id)).not.toBeNull();
    expect(await entities.findTrackForUser(userB.id, track.id)).toBeNull();

    await database.user.delete({ where: { id: userA.id } });
    expect(
      await database.spotifyAccount.findUnique({ where: { id: accountA.id } }),
    ).toBeNull();
    expect(
      await database.syncState.findUnique({
        where: { spotifyAccountId: accountA.id },
      }),
    ).toBeNull();
    expect(
      await database.listeningHistory.count({
        where: { spotifyAccountId: accountA.id },
      }),
    ).toBe(0);
    expect(
      await database.spotifyAccount.findUnique({ where: { id: accountB.id } }),
    ).not.toBeNull();
    expect(
      await database.track.findUnique({ where: { id: track.id } }),
    ).not.toBeNull();
  });
});

describe('OAuth and session persistence', () => {
  it('stores only hashes and consumes OAuth state once before expiry', async () => {
    const rawState = 'raw-oauth-state-that-must-not-be-stored';
    const now = new Date('2026-09-03T12:00:00.000Z');
    await storeOAuthState(database, rawState, '/history', undefined, now);
    const stored = await database.oAuthState.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
    });
    expect(stored.stateHash).not.toContain(rawState);
    await expect(
      consumeOAuthState(database, rawState, now),
    ).resolves.toMatchObject({ returnPath: '/history' });
    await expect(
      consumeOAuthState(database, rawState, now),
    ).resolves.toBeNull();

    await storeOAuthState(
      database,
      'expired-state',
      '/',
      undefined,
      new Date('2026-09-03T10:00:00.000Z'),
    );
    await expect(
      consumeOAuthState(database, 'expired-state', now),
    ).resolves.toBeNull();
  });

  it('stores hashed durable rate counters and rejects above the limit', async () => {
    const now = new Date('2026-09-03T12:00:00.000Z');
    await enforceRateLimit(database, 'raw-client-address', 2, 60, now);
    await enforceRateLimit(database, 'raw-client-address', 2, 60, now);
    await expect(
      enforceRateLimit(database, 'raw-client-address', 2, 60, now),
    ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    const entries = await database.oAuthState.findMany({
      where: { purpose: 'RATE' },
      select: { rateKey: true },
    });
    expect(JSON.stringify(entries)).not.toContain('raw-client-address');
    await expect(
      enforceRateLimit(
        database,
        'raw-client-address',
        2,
        60,
        new Date(now.getTime() + 60_001),
      ),
    ).resolves.toBeUndefined();
  });

  it('stores only session and CSRF hashes and revokes the session', async () => {
    const user = await database.user.create({ data: { status: 'ACTIVE' } });
    const created = await createSession(database, user.id, new Date());
    const stored = await database.appSession.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(stored.tokenHash).not.toContain(created.token);
    expect(stored.csrfHash).not.toContain(created.csrfToken);
    await expect(
      resolveSession(database, created.token),
    ).resolves.toMatchObject({ userId: user.id });
    await revokeSession(database, created.token);
    await expect(resolveSession(database, created.token)).resolves.toBeNull();
  });
});

async function createSyncAccount(
  suffix: string,
  cursorPlayedAt: Date | null = null,
) {
  const user = await database.user.create({ data: { status: 'ACTIVE' } });
  const expiry = new Date('2027-09-03T00:00:00.000Z');
  const envelope = {
    version: 'v1',
    ciphertext: 'fixture',
    nonce: 'fixture',
    tag: 'fixture',
  };
  return database.spotifyAccount.create({
    data: {
      userId: user.id,
      spotifyAccountId: `sync-${suffix}`,
      accessTokenEnvelope: envelope,
      refreshTokenEnvelope: envelope,
      accessTokenExpiresAt: expiry,
      refreshTokenExpiresAt: expiry,
      scopes: ['user-read-private', 'user-read-recently-played'],
      syncState: {
        create: {
          cursorPlayedAt,
          nextSyncAt: new Date('2026-09-03T10:00:00.000Z'),
        },
      },
    },
    include: { syncState: true },
  });
}

describe('synchronization persistence', () => {
  it('lets two workers replay the same 50 items without extra rows', async () => {
    const account = await createSyncAccount('concurrent-dedupe');
    const track = await database.track.create({
      data: {
        externalKey: 'spotify:concurrent-dedupe',
        spotifyId: 'concurrent-dedupe',
        name: 'Concurrent',
        normalizedName: 'concurrent',
        durationMs: 1,
        metadataFetchedAt: new Date(),
      },
    });
    const items = Array.from({ length: 50 }, (_, index) => ({
      spotifyAccountId: account.id,
      trackId: track.id,
      playedAt: new Date(Date.UTC(2026, 8, 2, 0, index)),
      estimatedDurationMs: 1,
    }));
    const workers = await Promise.all([
      database.listeningHistory.createMany({
        data: items,
        skipDuplicates: true,
      }),
      database.listeningHistory.createMany({
        data: items,
        skipDuplicates: true,
      }),
    ]);
    expect(workers.reduce((sum, result) => sum + result.count, 0)).toBe(50);
    expect(
      await database.listeningHistory.count({
        where: { spotifyAccountId: account.id },
      }),
    ).toBe(50);
  });

  it('leases a due account once and reclaims an expired running lease', async () => {
    const account = await createSyncAccount('lease');
    const now = new Date('2026-09-03T12:00:00.000Z');
    const leases = await Promise.all([
      leaseNextDueAccount(database, 'worker-a', now),
      leaseNextDueAccount(database, 'worker-b', now),
    ]);
    expect(
      leases.filter((lease) => lease?.spotifyAccountId === account.id),
    ).toHaveLength(1);
    const owner = leases.find(
      (lease) => lease?.spotifyAccountId === account.id,
    )!.leaseOwner;
    expect(
      await heartbeatLease(database, account.id, 'wrong-worker', now),
    ).toBe(false);
    expect(await heartbeatLease(database, account.id, owner, now)).toBe(true);

    await database.syncState.update({
      where: { spotifyAccountId: account.id },
      data: {
        status: 'RUNNING',
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(now.getTime() - 1),
        nextSyncAt: now,
      },
    });
    await expect(
      leaseNextDueAccount(database, 'replacement-worker', now),
    ).resolves.toMatchObject({
      spotifyAccountId: account.id,
      leaseOwner: 'replacement-worker',
    });
  });

  /**
   * H3: heartbeatLease had no production caller. A run is up to ten pages with
   * five attempts each and backoff between them, so the 120s lease expired
   * mid-run, a second worker was granted one, and the first run's entire batch
   * was discarded with no SyncRun row, no failure counter, and no gap warning.
   */
  it('renews the lease across pages and aborts with lease_lost when it is stolen', async () => {
    const key = Buffer.alloc(32, 11);
    const environment = parseEnvironment({
      NODE_ENV: 'test',
      APP_URL: 'https://listen.test',
      PORT: '3000',
      POSTGRES_DB: 'resonance',
      POSTGRES_USER: 'resonance',
      POSTGRES_PASSWORD: 'integration-database-password',
      DATABASE_URL: 'postgresql://resonance:password@postgres:5432/resonance',
      SPOTIFY_CLIENT_ID: 'client-id',
      SPOTIFY_CLIENT_SECRET: 'integration-client-secret-long',
      SPOTIFY_REDIRECT_URI: 'https://listen.test/api/auth/callback',
      SESSION_SECRET: Buffer.alloc(32, 12).toString('base64'),
      TOKEN_ENCRYPTION_KEY: key.toString('base64'),
      TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
      SYNC_INTERVAL_SECONDS: '180',
      SYNC_OVERLAP_SECONDS: '300',
      DATA_RETENTION_DAYS: '730',
      TRUST_PROXY: '1',
      APP_VERSION: 'test',
    });

    async function leasedAccount(suffix: string) {
      const user = await database.user.create({ data: { status: 'ACTIVE' } });
      const accountId = crypto.randomUUID();
      const far = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      await database.spotifyAccount.create({
        data: {
          id: accountId,
          userId: user.id,
          spotifyAccountId: `lease-run-${suffix}`,
          accessTokenEnvelope: encryptToken(
            'fresh-access',
            { accountId, type: 'access', version: 'v1' },
            key,
          ),
          refreshTokenEnvelope: encryptToken(
            'fresh-refresh',
            { accountId, type: 'refresh', version: 'v1' },
            key,
          ),
          // Comfortably beyond the 5 minute skew, so no HTTP refresh happens.
          accessTokenExpiresAt: far,
          refreshTokenExpiresAt: far,
          scopes: ['user-read-private', 'user-read-recently-played'],
          syncState: { create: { nextSyncAt: new Date(0) } },
        },
      });
      const lease = await leaseNextDueAccount(database, `worker-${suffix}`);
      expect(lease?.spotifyAccountId).toBe(accountId);
      return { accountId, workerId: `worker-${suffix}` };
    }

    /** A fake slow provider: `pages` pages, each linking to the next. */
    function slowProvider(pages: number, onPage?: () => Promise<void>) {
      let served = 0;
      return (async () => {
        served += 1;
        await onPage?.();
        const next =
          served < pages
            ? `https://api.spotify.com/v1/me/player/recently-played?after=${served}`
            : null;
        return new Response(
          JSON.stringify({
            items: [spotifyItem({ played_at: `2026-09-0${served}T00:00:00Z` })],
            next,
            cursors: { after: String(served) },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
    }

    // 1. A lease that lapses before the run finishes. The provider is slow
    //    enough that only a real heartbeat can carry the run past the expiry
    //    -- the 120s-lease-versus-long-run case in miniature.
    const alive = await leasedAccount('alive');
    await database.syncState.update({
      where: { spotifyAccountId: alive.accountId },
      data: { leaseExpiresAt: new Date(Date.now() + 300) },
    });
    await syncLeasedAccount(
      database,
      alive.accountId,
      alive.workerId,
      environment,
      undefined,
      {
        fetcher: slowProvider(
          3,
          () => new Promise((resolve) => setTimeout(resolve, 200)),
        ),
        sleep: async () => undefined,
        random: () => 0,
      },
    );
    const aliveRuns = await database.syncRun.findMany({
      where: { spotifyAccountId: alive.accountId },
    });
    expect(aliveRuns).toHaveLength(1);
    expect(aliveRuns[0]!.outcome).toBe('SUCCEEDED');
    expect(aliveRuns[0]!.pagesFetched).toBe(3);
    expect(
      await database.listeningHistory.count({
        where: { spotifyAccountId: alive.accountId },
      }),
    ).toBe(3);

    // 2. Now steal the lease between pages, exactly as an expiry-and-reclaim
    //    would. The run must abort and leave a lease_lost record behind.
    const lost = await leasedAccount('lost');
    let pagesServed = 0;
    await syncLeasedAccount(
      database,
      lost.accountId,
      lost.workerId,
      environment,
      undefined,
      {
        fetcher: slowProvider(5, async () => {
          pagesServed += 1;
          if (pagesServed === 2) {
            // The lease lapses and a replacement worker claims it.
            await database.syncState.update({
              where: { spotifyAccountId: lost.accountId },
              data: {
                leaseOwner: 'replacement-worker',
                leaseExpiresAt: new Date(Date.now() + 120_000),
              },
            });
          }
        }),
        sleep: async () => undefined,
        random: () => 0,
      },
    );

    // The batch was abandoned rather than written.
    expect(
      await database.listeningHistory.count({
        where: { spotifyAccountId: lost.accountId },
      }),
    ).toBe(0);
    // ...and the discarded work is visible to the operator.
    const lostRuns = await database.syncRun.findMany({
      where: { spotifyAccountId: lost.accountId },
    });
    expect(lostRuns).toHaveLength(1);
    expect(lostRuns[0]!.errorClass).toBe(LEASE_LOST_ERROR_CLASS);
    // The replacement worker's lease was not clobbered on the way out.
    const lostState = await database.syncState.findUniqueOrThrow({
      where: { spotifyAccountId: lost.accountId },
    });
    expect(lostState.leaseOwner).toBe('replacement-worker');
    // The run stopped early instead of walking all five pages.
    expect(pagesServed).toBeLessThan(5);
  });

  /**
   * H4: Retry-After was honoured with no ceiling and no attempt counter, so a
   * hostile `Retry-After: 86400` parked the worker for a day on a held lease.
   * A rate limit now ends the run as a deferral with the cursor untouched.
   */
  it('ends a rate-limited run as RATE_LIMITED and preserves the cursor', async () => {
    const key = Buffer.alloc(32, 13);
    const environment = parseEnvironment({
      NODE_ENV: 'test',
      APP_URL: 'https://listen.test',
      PORT: '3000',
      POSTGRES_DB: 'resonance',
      POSTGRES_USER: 'resonance',
      POSTGRES_PASSWORD: 'integration-database-password',
      DATABASE_URL: 'postgresql://resonance:password@postgres:5432/resonance',
      SPOTIFY_CLIENT_ID: 'client-id',
      SPOTIFY_CLIENT_SECRET: 'integration-client-secret-long',
      SPOTIFY_REDIRECT_URI: 'https://listen.test/api/auth/callback',
      SESSION_SECRET: Buffer.alloc(32, 14).toString('base64'),
      TOKEN_ENCRYPTION_KEY: key.toString('base64'),
      TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
      SYNC_INTERVAL_SECONDS: '180',
      SYNC_OVERLAP_SECONDS: '300',
      DATA_RETENTION_DAYS: '730',
      TRUST_PROXY: '1',
      APP_VERSION: 'test',
    });
    const cursor = new Date('2026-09-01T00:00:00.000Z');
    const user = await database.user.create({ data: { status: 'ACTIVE' } });
    const accountId = crypto.randomUUID();
    const far = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await database.spotifyAccount.create({
      data: {
        id: accountId,
        userId: user.id,
        spotifyAccountId: 'rate-limited-run',
        accessTokenEnvelope: encryptToken(
          'fresh-access',
          { accountId, type: 'access', version: 'v1' },
          key,
        ),
        refreshTokenEnvelope: encryptToken(
          'fresh-refresh',
          { accountId, type: 'refresh', version: 'v1' },
          key,
        ),
        accessTokenExpiresAt: far,
        refreshTokenExpiresAt: far,
        scopes: ['user-read-private', 'user-read-recently-played'],
        syncState: {
          create: { nextSyncAt: new Date(0), cursorPlayedAt: cursor },
        },
      },
    });
    const lease = await leaseNextDueAccount(database, 'worker-429');
    expect(lease?.spotifyAccountId).toBe(accountId);

    const started = Date.now();
    let requests = 0;
    await syncLeasedAccount(
      database,
      accountId,
      'worker-429',
      environment,
      undefined,
      {
        // A hostile day-long Retry-After on every attempt.
        fetcher: (async () => {
          requests += 1;
          return new Response('', {
            status: 429,
            headers: { 'Retry-After': '86400' },
          });
        }) as unknown as typeof fetch,
        random: () => 0,
      },
    );
    // No real sleep was injected, so a missing ceiling would have hung here.
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(requests).toBe(1);

    const runs = await database.syncRun.findMany({
      where: { spotifyAccountId: accountId },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('RATE_LIMITED');
    const state = await database.syncState.findUniqueOrThrow({
      where: { spotifyAccountId: accountId },
    });
    expect(state.cursorPlayedAt).toEqual(cursor);
    expect(state.leaseOwner).toBeNull();
    // The remainder is deferred rather than slept through.
    expect(state.nextSyncAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('serializes refresh, preserves an omitted refresh token, and persists NEEDS_REAUTH', async () => {
    const key = Buffer.alloc(32, 7);
    const otherKey = Buffer.alloc(32, 8);
    const environment = parseEnvironment({
      NODE_ENV: 'test',
      APP_URL: 'https://listen.test',
      PORT: '3000',
      POSTGRES_DB: 'resonance',
      POSTGRES_USER: 'resonance',
      POSTGRES_PASSWORD: 'integration-database-password',
      DATABASE_URL: 'postgresql://resonance:password@postgres:5432/resonance',
      SPOTIFY_CLIENT_ID: 'client-id',
      SPOTIFY_CLIENT_SECRET: 'integration-client-secret-long',
      SPOTIFY_REDIRECT_URI: 'https://listen.test/api/auth/callback',
      SESSION_SECRET: otherKey.toString('base64'),
      TOKEN_ENCRYPTION_KEY: key.toString('base64'),
      TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
      SYNC_INTERVAL_SECONDS: '180',
      SYNC_OVERLAP_SECONDS: '300',
      DATA_RETENTION_DAYS: '730',
      TRUST_PROXY: '1',
      APP_VERSION: 'test',
    });
    const user = await database.user.create({ data: { status: 'ACTIVE' } });
    const accountId = crypto.randomUUID();
    const now = new Date('2026-09-03T12:00:00.000Z');
    const account = await database.spotifyAccount.create({
      data: {
        id: accountId,
        userId: user.id,
        spotifyAccountId: 'refresh-account',
        accessTokenEnvelope: encryptToken(
          'old-access',
          { accountId, type: 'access', version: 'v1' },
          key,
        ),
        refreshTokenEnvelope: encryptToken(
          'old-refresh',
          { accountId, type: 'refresh', version: 'v1' },
          key,
        ),
        accessTokenExpiresAt: new Date(now.getTime() + 10_000),
        refreshTokenExpiresAt: new Date(now.getTime() + 10_000_000),
        scopes: ['user-read-private', 'user-read-recently-played'],
        syncState: { create: {} },
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      Promise.all([
        validAccessToken(database, account.id, environment, now),
        validAccessToken(database, account.id, environment, now),
      ]),
    ).resolves.toEqual(['new-access', 'new-access']);
    expect(fetcher).toHaveBeenCalledOnce();
    const refreshed = await database.spotifyAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(
      decryptToken(
        refreshed.refreshTokenEnvelope,
        { accountId, type: 'refresh' },
        new Map([['v1', key]]),
      ),
    ).toBe('old-refresh');

    await database.spotifyAccount.update({
      where: { id: account.id },
      data: { accessTokenExpiresAt: new Date(now.getTime() - 1) },
    });
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    await expect(
      validAccessToken(database, account.id, environment, now),
    ).rejects.toThrow('renewed');
    expect(
      await database.spotifyAccount.findUniqueOrThrow({
        where: { id: account.id },
      }),
    ).toMatchObject({ state: 'NEEDS_REAUTH' });
    expect(
      await database.syncState.findUniqueOrThrow({
        where: { spotifyAccountId: account.id },
      }),
    ).toMatchObject({ status: 'NEEDS_REAUTH' });
    vi.unstubAllGlobals();
  });

  it('commits entities, events, cursor, audit, dedupe, and probable gap together', async () => {
    const oldCursor = new Date('2026-09-01T00:00:00.000Z');
    const account = await createSyncAccount('persist', oldCursor);
    const now = new Date('2026-09-03T12:30:00.000Z');
    await database.syncState.update({
      where: { spotifyAccountId: account.id },
      data: {
        status: 'RUNNING',
        leaseOwner: 'worker-persist',
        leaseExpiresAt: new Date(now.getTime() + 120_000),
        lastAttemptAt: now,
      },
    });
    const items = Array.from({ length: 50 }, (_, index) =>
      spotifyItem({
        played_at: new Date(Date.UTC(2026, 8, 3, 11, index)).toISOString(),
      }),
    );
    const first = await persistSyncBatch(database, {
      accountId: account.id,
      workerId: 'worker-persist',
      requestId: 'run-one',
      items,
      pagesFetched: 1,
      bounded: true,
      intervalSeconds: 180,
      overlapSeconds: 300,
      now,
    });
    expect(first).toMatchObject({
      inserted: 50,
      duplicates: 0,
      probableGap: true,
    });
    expect(first.cursor?.toISOString()).toBe('2026-09-03T11:49:00.000Z');
    const state = await database.syncState.findUniqueOrThrow({
      where: { spotifyAccountId: account.id },
    });
    expect(state).toMatchObject({
      status: 'IDLE',
      probableGap: true,
      leaseOwner: null,
    });

    const replayTime = new Date(now.getTime() + 181_000);
    await database.syncState.update({
      where: { spotifyAccountId: account.id },
      data: {
        status: 'RUNNING',
        leaseOwner: 'worker-replay',
        leaseExpiresAt: new Date(replayTime.getTime() + 120_000),
        lastAttemptAt: replayTime,
      },
    });
    const replay = await persistSyncBatch(database, {
      accountId: account.id,
      workerId: 'worker-replay',
      requestId: 'run-two',
      items,
      pagesFetched: 1,
      bounded: false,
      intervalSeconds: 180,
      overlapSeconds: 300,
      now: replayTime,
    });
    expect(replay).toMatchObject({
      inserted: 0,
      duplicates: 50,
      probableGap: true,
    });
    expect(
      await database.listeningHistory.count({
        where: { spotifyAccountId: account.id },
      }),
    ).toBe(50);
    expect(
      await database.syncRun.count({
        where: { spotifyAccountId: account.id },
      }),
    ).toBe(2);
  });

  it('rolls back entities and preserves the cursor when an item fails', async () => {
    const cursor = new Date('2026-09-03T10:00:00.000Z');
    const account = await createSyncAccount('rollback', cursor);
    const now = new Date('2026-09-03T12:00:00.000Z');
    await database.syncState.update({
      where: { spotifyAccountId: account.id },
      data: {
        status: 'RUNNING',
        leaseOwner: 'worker-rollback',
        leaseExpiresAt: new Date(now.getTime() + 120_000),
        lastAttemptAt: now,
      },
    });
    const item = spotifyItem({
      track: {
        ...spotifyItem().track,
        id: 'poison-track',
        name: 'Poison Track',
        artists: [
          { id: 'duplicate-artist', name: 'Same Artist' },
          { id: 'duplicate-artist', name: 'Same Artist' },
        ],
      },
    });
    await expect(
      persistSyncBatch(database, {
        accountId: account.id,
        workerId: 'worker-rollback',
        requestId: 'run-rollback',
        items: [item],
        pagesFetched: 1,
        bounded: false,
        intervalSeconds: 180,
        overlapSeconds: 300,
        now,
      }),
    ).rejects.toThrow();
    expect(
      await database.track.findUnique({
        where: { externalKey: 'spotify:poison-track' },
      }),
    ).toBeNull();
    expect(
      (
        await database.syncState.findUniqueOrThrow({
          where: { spotifyAccountId: account.id },
        })
      ).cursorPlayedAt,
    ).toEqual(cursor);

    await recordSyncFailure(
      database,
      account.id,
      'worker-rollback',
      'run-rollback',
      'PayloadValidationError',
      now,
    );
    const failed = await database.syncState.findUniqueOrThrow({
      where: { spotifyAccountId: account.id },
    });
    expect(failed).toMatchObject({
      status: 'BACKOFF',
      consecutiveFailures: 1,
      cursorPlayedAt: cursor,
      leaseOwner: null,
    });
  });
});

describe('tenant-scoped API repositories', () => {
  it('paginates tied timestamps, normalizes search, isolates filters, and calculates artist credits', async () => {
    const [userA, userB] = await Promise.all([
      database.user.create({
        data: {
          status: 'ACTIVE',
          settings: { create: { timezone: 'America/Chicago' } },
        },
      }),
      database.user.create({
        data: { status: 'ACTIVE', settings: { create: {} } },
      }),
    ]);
    const expiry = new Date('2027-09-03T00:00:00Z');
    const envelope = {
      version: 'v1',
      ciphertext: 'fixture',
      nonce: 'fixture',
      tag: 'fixture',
    };
    const [accountA, accountB] = await Promise.all([
      database.spotifyAccount.create({
        data: {
          userId: userA.id,
          spotifyAccountId: 'api-account-a',
          accessTokenEnvelope: envelope,
          refreshTokenEnvelope: envelope,
          accessTokenExpiresAt: expiry,
          refreshTokenExpiresAt: expiry,
          scopes: [],
        },
      }),
      database.spotifyAccount.create({
        data: {
          userId: userB.id,
          spotifyAccountId: 'api-account-b',
          accessTokenEnvelope: envelope,
          refreshTokenEnvelope: envelope,
          accessTokenExpiresAt: expiry,
          refreshTokenExpiresAt: expiry,
          scopes: [],
        },
      }),
    ]);
    const [artist, collaborator, foreignArtist] = await Promise.all([
      database.artist.create({
        data: {
          externalKey: 'spotify:beyonce',
          spotifyId: 'beyonce',
          name: 'Beyoncé',
          normalizedName: 'beyonce',
          metadataFetchedAt: new Date(),
        },
      }),
      database.artist.create({
        data: {
          externalKey: 'spotify:collaborator',
          spotifyId: 'collaborator',
          name: 'Collaborator',
          normalizedName: 'collaborator',
          metadataFetchedAt: new Date(),
        },
      }),
      database.artist.create({
        data: {
          externalKey: 'spotify:foreign-artist',
          spotifyId: 'foreign-artist',
          name: 'Foreign',
          normalizedName: 'foreign',
          metadataFetchedAt: new Date(),
        },
      }),
    ]);
    const [trackOne, trackTwo, foreignTrack] = await Promise.all([
      database.track.create({
        data: {
          externalKey: 'spotify:api-track-one',
          spotifyId: 'api-track-one',
          name: 'Alpha',
          normalizedName: 'alpha',
          durationMs: 100,
          metadataFetchedAt: new Date(),
          artists: {
            create: [
              { artistId: artist.id, position: 0 },
              { artistId: collaborator.id, position: 1 },
            ],
          },
        },
      }),
      database.track.create({
        data: {
          externalKey: 'spotify:api-track-two',
          spotifyId: 'api-track-two',
          name: 'Zulu',
          normalizedName: 'zulu',
          durationMs: 200,
          metadataFetchedAt: new Date(),
          artists: { create: [{ artistId: artist.id, position: 0 }] },
        },
      }),
      database.track.create({
        data: {
          externalKey: 'spotify:foreign-track',
          spotifyId: 'foreign-track',
          name: 'Foreign',
          normalizedName: 'foreign',
          durationMs: 300,
          metadataFetchedAt: new Date(),
          artists: { create: [{ artistId: foreignArtist.id, position: 0 }] },
        },
      }),
    ]);
    const playedAt = new Date('2026-09-03T12:00:00Z');
    await database.listeningHistory.createMany({
      data: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          spotifyAccountId: accountA.id,
          trackId: trackOne.id,
          playedAt,
          estimatedDurationMs: 100,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          spotifyAccountId: accountA.id,
          trackId: trackTwo.id,
          playedAt,
          estimatedDurationMs: 200,
        },
        {
          spotifyAccountId: accountB.id,
          trackId: foreignTrack.id,
          playedAt,
          estimatedDurationMs: 300,
        },
      ],
    });
    const range = {
      preset: 'CUSTOM' as const,
      from: new Date('2026-09-03T00:00:00Z'),
      to: new Date('2026-09-04T00:00:00Z'),
      timezone: 'UTC',
    };
    const repository = new ApiRepository(database);
    const first = await repository.history(userA.id, {
      range,
      limit: 1,
      cursor: null,
    });
    const firstItem = first[0]!;
    const cursor = decodeCursor(
      encodeCursor({ at: firstItem.playedAt.toISOString(), id: firstItem.id }),
    );
    const second = await repository.history(userA.id, {
      range,
      limit: 1,
      cursor,
    });
    expect(firstItem.id).not.toBe(second[0]!.id);
    expect(new Set([firstItem.id, second[0]!.id]).size).toBe(2);

    const artists = await rankedEntities(
      database,
      userA.id,
      range,
      'artist',
      'BEYONCE',
      'plays',
    );
    expect(artists).toMatchObject([
      { id: artist.id, plays: 2, estimatedDurationMs: 300 },
    ]);
    const dashboard = await dashboardData(database, userA.id, range);
    expect(dashboard.totals).toEqual({
      plays: 2,
      estimatedDurationMs: 300,
      uniqueTracks: 2,
      uniqueAlbums: 0,
      uniqueArtists: 2,
    });
    await expect(
      assertOwnedEntityFilters(repository, userA.id, {
        trackId: foreignTrack.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await repository.entityForUser(userA.id, 'track', foreignTrack.id),
    ).toBeNull();
  });

  it('keeps a 10,000-event dashboard query bounded', async () => {
    const user = await database.user.create({ data: { status: 'ACTIVE' } });
    const expiry = new Date('2027-09-03T00:00:00Z');
    const envelope = {
      version: 'v1',
      ciphertext: 'fixture',
      nonce: 'fixture',
      tag: 'fixture',
    };
    const account = await database.spotifyAccount.create({
      data: {
        userId: user.id,
        spotifyAccountId: 'load-account',
        accessTokenEnvelope: envelope,
        refreshTokenEnvelope: envelope,
        accessTokenExpiresAt: expiry,
        refreshTokenExpiresAt: expiry,
        scopes: [],
      },
    });
    const track = await database.track.create({
      data: {
        externalKey: 'spotify:load-track',
        spotifyId: 'load-track',
        name: 'Load Track',
        normalizedName: 'load track',
        durationMs: 1000,
        metadataFetchedAt: new Date(),
      },
    });
    const start = Date.parse('2026-01-01T00:00:00Z');
    await database.listeningHistory.createMany({
      data: Array.from({ length: 10_000 }, (_, index) => ({
        spotifyAccountId: account.id,
        trackId: track.id,
        playedAt: new Date(start + index * 1000),
        estimatedDurationMs: 1000,
      })),
    });
    const began = performance.now();
    const result = await dashboardData(database, user.id, {
      preset: 'CUSTOM',
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-01-02T00:00:00Z'),
      timezone: 'UTC',
    });
    const elapsed = performance.now() - began;
    expect(result.totals).toMatchObject({
      plays: 10_000,
      estimatedDurationMs: 10_000_000,
    });
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('entity detail analytics', () => {
  it('returns complete scoped details and hides a foreign tenant', async () => {
    const envelope = {
      version: 'v1',
      ciphertext: 'fixture',
      nonce: 'fixture',
      tag: 'fixture',
    };
    const [owner, stranger] = await Promise.all([
      database.user.create({
        data: {
          status: 'ACTIVE',
          settings: { create: { timezone: 'UTC' } },
        },
      }),
      database.user.create({ data: { status: 'ACTIVE' } }),
    ]);
    const account = await database.spotifyAccount.create({
      data: {
        userId: owner.id,
        spotifyAccountId: `details-${owner.id}`,
        accessTokenEnvelope: envelope,
        refreshTokenEnvelope: envelope,
        accessTokenExpiresAt: new Date('2027-01-01T00:00:00Z'),
        refreshTokenExpiresAt: new Date('2027-01-01T00:00:00Z'),
        scopes: [],
      },
    });
    const artist = await database.artist.create({
      data: {
        externalKey: `spotify:details-artist-${owner.id}`,
        spotifyId: `details-artist-${owner.id}`,
        name: 'Detail Artist',
        normalizedName: 'detail artist',
        metadataFetchedAt: new Date(),
      },
    });
    const album = await database.album.create({
      data: {
        externalKey: `spotify:details-album-${owner.id}`,
        spotifyId: `details-album-${owner.id}`,
        name: 'Detail Album',
        normalizedName: 'detail album',
        metadataFetchedAt: new Date(),
        artists: { create: { artistId: artist.id, position: 0 } },
      },
    });
    const track = await database.track.create({
      data: {
        externalKey: `spotify:details-track-${owner.id}`,
        spotifyId: `details-track-${owner.id}`,
        albumId: album.id,
        name: 'Detail Track',
        normalizedName: 'detail track',
        durationMs: 180_000,
        metadataFetchedAt: new Date(),
        artists: { create: { artistId: artist.id, position: 0 } },
      },
    });
    await database.listeningHistory.createMany({
      data: [
        {
          spotifyAccountId: account.id,
          trackId: track.id,
          playedAt: new Date('2026-08-01T10:00:00Z'),
          estimatedDurationMs: 180_000,
        },
        {
          spotifyAccountId: account.id,
          trackId: track.id,
          playedAt: new Date('2026-08-02T10:00:00Z'),
          estimatedDurationMs: 180_000,
        },
      ],
    });
    const range = {
      preset: 'CUSTOM' as const,
      from: new Date('2026-08-01T00:00:00Z'),
      to: new Date('2026-08-03T00:00:00Z'),
      timezone: 'UTC',
    };
    const detail = await entityDetailData(
      database,
      owner.id,
      range,
      1,
      'artist',
      artist.id,
    );
    expect(detail).toMatchObject({
      rank: 1,
      totals: { plays: 2, estimatedDurationMs: 360_000 },
      topTracks: [{ id: track.id, plays: 2 }],
      topAlbums: [{ id: album.id, plays: 2 }],
    });
    expect(detail?.firstPlayedAt?.toISOString()).toBe(
      '2026-08-01T10:00:00.000Z',
    );
    await expect(
      entityDetailData(database, stranger.id, range, 1, 'track', track.id),
    ).resolves.toBeNull();
  });
});

describe('T-015/T-017 golden statistics', () => {
  it('matches hand-calculated totals, credits, ties, and DST buckets', async () => {
    // Fixture designed so every number below can be verified by hand.
    //
    // Timezone: America/New_York, week starts Monday.
    // Plays (all local times on 2026-03-07 and 2026-03-08, the DST weekend):
    //   1. 2026-03-07 10:00 EST  Alpha  (Ada + Bo)      120000 ms
    //   2. 2026-03-07 11:00 EST  Alpha  (Ada + Bo)      120000 ms
    //   3. 2026-03-07 12:00 EST  Bravo  (Ada)           180000 ms
    //   4. 2026-03-08 03:30 EDT  Charlie (Bo)           180000 ms
    //
    // Expected: 4 plays, 600000 ms, 3 unique tracks, 1 unique album (Charlie
    // has none), 2 unique artists, 6 artist play credits (2+2 for Alpha,
    // 1 for Bravo, 1 for Charlie => Ada 3, Bo 3).
    const user = await database.user.create({
      data: {
        status: 'ACTIVE',
        settings: {
          create: { timezone: 'America/New_York', weekStartsOn: 1 },
        },
      },
    });
    const envelope = {
      version: 'v1',
      ciphertext: 'fixture',
      nonce: 'fixture',
      tag: 'fixture',
    };
    const expiry = new Date('2027-09-03T00:00:00Z');
    const account = await database.spotifyAccount.create({
      data: {
        userId: user.id,
        spotifyAccountId: 'golden-account',
        accessTokenEnvelope: envelope,
        refreshTokenEnvelope: envelope,
        accessTokenExpiresAt: expiry,
        refreshTokenExpiresAt: expiry,
        scopes: [],
      },
    });

    const [ada, bo] = await Promise.all([
      database.artist.create({
        data: {
          externalKey: 'spotify:golden-ada',
          spotifyId: 'golden-ada',
          name: 'Ada',
          normalizedName: 'ada',
          metadataFetchedAt: new Date(),
        },
      }),
      database.artist.create({
        data: {
          externalKey: 'spotify:golden-bo',
          spotifyId: 'golden-bo',
          name: 'Bo',
          normalizedName: 'bo',
          metadataFetchedAt: new Date(),
        },
      }),
    ]);
    const album = await database.album.create({
      data: {
        externalKey: 'spotify:golden-album',
        spotifyId: 'golden-album',
        name: 'Golden',
        normalizedName: 'golden',
        metadataFetchedAt: new Date(),
      },
    });
    const [alpha, bravo, charlie] = await Promise.all([
      database.track.create({
        data: {
          externalKey: 'spotify:golden-alpha',
          spotifyId: 'golden-alpha',
          name: 'Alpha',
          normalizedName: 'alpha',
          durationMs: 120_000,
          albumId: album.id,
          metadataFetchedAt: new Date(),
          artists: {
            create: [
              { artistId: ada.id, position: 0 },
              { artistId: bo.id, position: 1 },
            ],
          },
        },
      }),
      database.track.create({
        data: {
          externalKey: 'spotify:golden-bravo',
          spotifyId: 'golden-bravo',
          name: 'Bravo',
          normalizedName: 'bravo',
          durationMs: 180_000,
          albumId: album.id,
          metadataFetchedAt: new Date(),
          artists: { create: [{ artistId: ada.id, position: 0 }] },
        },
      }),
      database.track.create({
        data: {
          externalKey: 'spotify:golden-charlie',
          spotifyId: 'golden-charlie',
          name: 'Charlie',
          normalizedName: 'charlie',
          durationMs: 180_000,
          metadataFetchedAt: new Date(),
          artists: { create: [{ artistId: bo.id, position: 0 }] },
        },
      }),
    ]);

    await database.listeningHistory.createMany({
      data: [
        {
          spotifyAccountId: account.id,
          trackId: alpha.id,
          playedAt: new Date('2026-03-07T15:00:00Z'),
          estimatedDurationMs: 120_000,
        },
        {
          spotifyAccountId: account.id,
          trackId: alpha.id,
          playedAt: new Date('2026-03-07T16:00:00Z'),
          estimatedDurationMs: 120_000,
        },
        {
          spotifyAccountId: account.id,
          trackId: bravo.id,
          playedAt: new Date('2026-03-07T17:00:00Z'),
          estimatedDurationMs: 180_000,
        },
        {
          spotifyAccountId: account.id,
          trackId: charlie.id,
          playedAt: new Date('2026-03-08T07:30:00Z'),
          estimatedDurationMs: 180_000,
        },
      ],
    });

    const range = resolveRange({
      preset: 'CUSTOM',
      timezone: 'America/New_York',
      weekStartsOn: 1,
      now: new Date('2026-03-10T12:00:00Z'),
      customFrom: '2026-03-07',
      customTo: '2026-03-08',
    });
    const result = await analyticsData(database, user.id, range, 1, {
      rankingLimit: 10,
      distributionLimit: 5,
    });

    expect(result.totals).toEqual({
      plays: 4,
      estimatedDurationMs: 600_000,
      uniqueTracks: 3,
      uniqueAlbums: 1,
      uniqueArtists: 2,
      artistPlayCredits: 6,
    });

    // Ada and Bo tie on 3 credits each. Tie-break is estimated duration desc
    // (Ada 120+120+180 = 420000, Bo 120+120+180 = 420000), then normalized
    // name ascending, so "ada" precedes "bo".
    expect(
      result.rankings.artists.map((entry) => [entry.name, entry.plays]),
    ).toEqual([
      ['Ada', 3],
      ['Bo', 3],
    ]);
    expect(result.rankings.artists[0]!.estimatedDurationMs).toBe(420_000);

    // Alpha has 2 plays; Bravo and Charlie tie at 1 play and 180000 ms, so
    // the normalized name decides: "bravo" before "charlie".
    expect(
      result.rankings.tracks.map((entry) => [entry.name, entry.plays]),
    ).toEqual([
      ['Alpha', 2],
      ['Bravo', 1],
      ['Charlie', 1],
    ]);

    // Day buckets span the 23-hour spring-forward day without gaps.
    expect(result.bucketDefinitions.granularity).toBe('day');
    expect(result.time.map((point) => [point.bucket, point.plays])).toEqual([
      ['2026-03-07', 3],
      ['2026-03-08', 1],
    ]);

    // The 03:30 EDT play lands in local hour 3, not the UTC hour 7.
    expect(result.hourly).toHaveLength(24);
    expect(result.hourly[3]).toEqual({
      bucket: '03',
      plays: 1,
      estimatedDurationMs: 180_000,
    });
    expect(result.hourly.reduce((sum, point) => sum + point.plays, 0)).toBe(4);

    // Weekday buckets start on Monday and sum to the range total.
    expect(result.weekday).toHaveLength(7);
    expect(result.weekday[0]!.bucket).toBe('Monday');
    expect(result.weekday.reduce((sum, point) => sum + point.plays, 0)).toBe(4);
    expect(result.hourWeekday).toHaveLength(7);
    expect(
      result.hourWeekday
        .flatMap((day) => day.points)
        .reduce((sum, point) => sum + point.plays, 0),
    ).toBe(4);
    expect(
      result.weekday.find((point) => point.bucket === 'Saturday')!.plays,
    ).toBe(3);
    expect(
      result.weekday.find((point) => point.bucket === 'Sunday')!.plays,
    ).toBe(1);

    // Artist credits (6) are the distribution denominator, not plays (4).
    expect(result.distributions.artists.denominator).toBe(6);
    // Only Alpha and Bravo carry an album, so 3 of 4 plays have one.
    expect(result.distributions.albums.denominator).toBe(3);

    const selectedYears = await analyticsData(database, user.id, range, 1, {
      years: [2025, 2026],
      distributionLimit: 1,
    });
    expect(selectedYears.yearOverYear.map(({ year }) => year)).toEqual([
      2025, 2026,
    ]);
    expect(selectedYears.yearOverYear[0]!.points).toHaveLength(365);
    expect(selectedYears.yearOverYear[1]!.points).toHaveLength(365);
    expect(
      selectedYears.yearOverYear[1]!.points.reduce(
        (sum, point) => sum + point.plays,
        0,
      ),
    ).toBe(4);
    expect(
      selectedYears.distributions.artists.items.reduce(
        (sum, item) => sum + item.plays,
        0,
      ),
    ).toBe(selectedYears.distributions.artists.denominator);

    // T-017: an empty range returns zeroed totals and zero-filled series.
    const emptyRange = resolveRange({
      preset: 'CUSTOM',
      timezone: 'America/New_York',
      weekStartsOn: 1,
      now: new Date('2026-03-10T12:00:00Z'),
      customFrom: '2026-01-01',
      customTo: '2026-01-02',
    });
    const empty = await analyticsData(database, user.id, emptyRange, 1);
    expect(empty.totals).toEqual({
      plays: 0,
      estimatedDurationMs: 0,
      uniqueTracks: 0,
      uniqueAlbums: 0,
      uniqueArtists: 0,
      artistPlayCredits: 0,
    });
    expect(empty.time.map((point) => point.bucket)).toEqual([
      '2026-01-01',
      '2026-01-02',
    ]);
    expect(empty.time.every((point) => point.plays === 0)).toBe(true);
    expect(empty.hourly).toHaveLength(24);
    expect(empty.weekday).toHaveLength(7);
    expect(empty.rankings.artists).toEqual([]);
    expect(empty.distributions.artists.denominator).toBe(0);
    expect(empty.distributions.artists.items).toEqual([]);
  });
});

describe('T-023 retention', () => {
  it('disconnects idempotently', async () => {
    const user = await database.user.create({
      data: { status: 'ACTIVE', settings: { create: {} } },
    });
    await disconnectUser(database, user.id);
    await disconnectUser(database, user.id);
    await expect(
      database.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).resolves.toMatchObject({ status: 'DISCONNECTED' });
  });

  it('removes expired history, keeps referenced metadata, and purges orphans', async () => {
    const envelope = {
      version: 'v1',
      ciphertext: 'fixture',
      nonce: 'fixture',
      tag: 'fixture',
    };
    const expiry = new Date('2027-09-03T00:00:00Z');
    const now = new Date('2026-09-03T00:00:00Z');

    // Retention is per user: 30 days here, 730 for the second user, so a
    // single global cutoff would produce the wrong answer for one of them.
    const [shortUser, longUser] = await Promise.all([
      database.user.create({
        data: {
          status: 'ACTIVE',
          settings: { create: { retentionDays: 30 } },
        },
      }),
      database.user.create({
        data: {
          status: 'ACTIVE',
          settings: { create: { retentionDays: 730 } },
        },
      }),
    ]);
    const [shortAccount, longAccount] = await Promise.all([
      database.spotifyAccount.create({
        data: {
          userId: shortUser.id,
          spotifyAccountId: 'retention-short',
          accessTokenEnvelope: envelope,
          refreshTokenEnvelope: envelope,
          accessTokenExpiresAt: expiry,
          refreshTokenExpiresAt: expiry,
          scopes: [],
        },
      }),
      database.spotifyAccount.create({
        data: {
          userId: longUser.id,
          spotifyAccountId: 'retention-long',
          accessTokenEnvelope: envelope,
          refreshTokenEnvelope: envelope,
          accessTokenExpiresAt: expiry,
          refreshTokenExpiresAt: expiry,
          scopes: [],
        },
      }),
    ]);

    const artist = await database.artist.create({
      data: {
        externalKey: 'spotify:retention-artist',
        spotifyId: 'retention-artist',
        name: 'Kept',
        normalizedName: 'kept',
        metadataFetchedAt: now,
      },
    });
    const album = await database.album.create({
      data: {
        externalKey: 'spotify:retention-album',
        spotifyId: 'retention-album',
        name: 'Kept Album',
        normalizedName: 'kept album',
        metadataFetchedAt: now,
      },
    });
    // sharedTrack stays referenced by the long-retention user, so it must
    // survive even though the short-retention user's event is deleted.
    const [sharedTrack, doomedTrack] = await Promise.all([
      database.track.create({
        data: {
          externalKey: 'spotify:retention-shared',
          spotifyId: 'retention-shared',
          name: 'Shared',
          normalizedName: 'shared',
          durationMs: 1000,
          albumId: album.id,
          metadataFetchedAt: now,
          artists: { create: [{ artistId: artist.id, position: 0 }] },
        },
      }),
      database.track.create({
        data: {
          externalKey: 'spotify:retention-doomed',
          spotifyId: 'retention-doomed',
          name: 'Doomed',
          normalizedName: 'doomed',
          durationMs: 1000,
          metadataFetchedAt: now,
          artists: { create: [{ artistId: artist.id, position: 0 }] },
        },
      }),
    ]);

    const daysAgo = (days: number) =>
      new Date(now.getTime() - days * 86_400_000);

    await database.listeningHistory.createMany({
      data: [
        // Short user: one inside the 30-day window, two outside it.
        {
          spotifyAccountId: shortAccount.id,
          trackId: sharedTrack.id,
          playedAt: daysAgo(10),
          estimatedDurationMs: 1000,
        },
        {
          spotifyAccountId: shortAccount.id,
          trackId: sharedTrack.id,
          playedAt: daysAgo(31),
          estimatedDurationMs: 1000,
        },
        {
          spotifyAccountId: shortAccount.id,
          trackId: doomedTrack.id,
          playedAt: daysAgo(400),
          estimatedDurationMs: 1000,
        },
        // Long user: 400 days is well inside a 730-day window.
        {
          spotifyAccountId: longAccount.id,
          trackId: sharedTrack.id,
          playedAt: daysAgo(400),
          estimatedDurationMs: 1000,
        },
      ],
    });

    // Expired session, stale OAuth state, and an old sync run.
    await database.appSession.create({
      data: {
        userId: shortUser.id,
        tokenHash: 'retention-expired-session',
        csrfHash: 'retention-expired-csrf',
        expiresAt: daysAgo(2),
        idleAt: daysAgo(2),
      },
    });
    await database.appSession.create({
      data: {
        userId: longUser.id,
        tokenHash: 'retention-live-session',
        csrfHash: 'retention-live-csrf',
        expiresAt: new Date(now.getTime() + 86_400_000),
        idleAt: new Date(now.getTime() + 86_400_000),
      },
    });
    await database.oAuthState.create({
      data: {
        stateHash: 'retention-stale-state',
        expiresAt: daysAgo(3),
      },
    });
    await database.syncRun.create({
      data: {
        spotifyAccountId: shortAccount.id,
        startedAt: daysAgo(200),
        outcome: 'SUCCEEDED',
        requestId: 'retention-old-run',
      },
    });
    await database.syncRun.create({
      data: {
        spotifyAccountId: shortAccount.id,
        startedAt: daysAgo(5),
        outcome: 'SUCCEEDED',
        requestId: 'retention-recent-run',
      },
    });

    const summary = await runRetention(database, {
      syncRunRetentionDays: 90,
      now,
    });

    // Two of the short user's three events expired; the long user's stayed.
    expect(summary.historyDeleted).toBe(2);
    const shortRemaining = await database.listeningHistory.findMany({
      where: { spotifyAccountId: shortAccount.id },
    });
    expect(shortRemaining).toHaveLength(1);
    expect(shortRemaining[0]!.playedAt).toEqual(daysAgo(10));
    expect(
      await database.listeningHistory.count({
        where: { spotifyAccountId: longAccount.id },
      }),
    ).toBe(1);

    // The shared track is still referenced, so it survives; the orphan does not.
    expect(
      await database.track.findUnique({ where: { id: sharedTrack.id } }),
    ).not.toBeNull();
    expect(
      await database.track.findUnique({ where: { id: doomedTrack.id } }),
    ).toBeNull();
    // Its album and artist remain reachable through the surviving track.
    expect(
      await database.album.findUnique({ where: { id: album.id } }),
    ).not.toBeNull();
    expect(
      await database.artist.findUnique({ where: { id: artist.id } }),
    ).not.toBeNull();

    // Expired session removed, live session kept.
    expect(
      await database.appSession.findUnique({
        where: { tokenHash: 'retention-expired-session' },
      }),
    ).toBeNull();
    expect(
      await database.appSession.findUnique({
        where: { tokenHash: 'retention-live-session' },
      }),
    ).not.toBeNull();

    expect(
      await database.oAuthState.findUnique({
        where: { stateHash: 'retention-stale-state' },
      }),
    ).toBeNull();

    const runs = await database.syncRun.findMany({
      where: { spotifyAccountId: shortAccount.id },
      select: { requestId: true },
    });
    expect(runs.map((run) => run.requestId)).toEqual(['retention-recent-run']);

    // Running again is a no-op, proving the pass is idempotent.
    const second = await runRetention(database, {
      syncRunRetentionDays: 90,
      now,
    });
    expect(second.historyDeleted).toBe(0);
    expect(second.tracksPurged).toBe(0);
  });

  it('completes a deferred disconnection and flags one past the deadline', async () => {
    const envelope = {
      version: 'v1',
      ciphertext: 'fixture',
      nonce: 'fixture',
      tag: 'fixture',
    };
    const expiry = new Date('2027-09-03T00:00:00Z');
    const now = new Date('2026-09-03T00:00:00Z');

    const user = await database.user.create({
      data: { status: 'ACTIVE', settings: { create: {} } },
    });
    const account = await database.spotifyAccount.create({
      data: {
        userId: user.id,
        spotifyAccountId: 'retention-deleting',
        accessTokenEnvelope: envelope,
        refreshTokenEnvelope: envelope,
        accessTokenExpiresAt: expiry,
        refreshTokenExpiresAt: expiry,
        scopes: [],
        state: 'DELETING',
      },
    });
    await database.appSession.create({
      data: {
        userId: user.id,
        tokenHash: 'retention-deleting-session',
        csrfHash: 'retention-deleting-csrf',
        expiresAt: new Date(now.getTime() + 86_400_000),
        idleAt: new Date(now.getTime() + 86_400_000),
      },
    });

    // Backdate the account so it is past the five-day contractual deadline.
    await database.$executeRaw`
      UPDATE spotify_accounts SET updated_at = ${new Date(now.getTime() - 6 * 86_400_000)}
      WHERE id = ${account.id}::uuid`;

    const summary = await runRetention(database, {
      syncRunRetentionDays: 90,
      now,
    });

    expect(summary.accountsDeleted).toBeGreaterThanOrEqual(1);
    expect(summary.deletionsOverdue).toBeGreaterThanOrEqual(1);
    expect(
      await database.spotifyAccount.findUnique({ where: { id: account.id } }),
    ).toBeNull();
    const cleared = await database.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(cleared.status).toBe('DISCONNECTED');
    expect(cleared.deletedAt).not.toBeNull();
  });
});
