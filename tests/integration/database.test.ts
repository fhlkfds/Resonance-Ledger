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
import { persistSyncBatch, recordSyncFailure } from '@/lib/spotify/persist';
import { validAccessToken } from '@/lib/spotify/access-token';
import { decryptToken, encryptToken } from '@/lib/crypto/token-envelope';
import { parseEnvironment } from '@/lib/env';
import { ApiRepository } from '@/lib/db/repositories/api';
import { assertOwnedEntityFilters } from '@/lib/api/ownership';
import { decodeCursor, encodeCursor } from '@/lib/api/pagination';
import { dashboardData, rankedEntities } from '@/lib/stats/queries';
import { entityDetailData } from '@/lib/stats/entity-details';
import { analyticsData } from '@/lib/stats/analytics';
import { resolveRange } from '@/lib/stats/dates';
import { enforceRateLimit } from '@/lib/api/rate-limit';
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
