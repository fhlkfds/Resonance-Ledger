import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
