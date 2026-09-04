import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlWithLimits } from '@/lib/db/client';
import { ApiRepository } from '@/lib/db/repositories/api';
import { resolveRange } from '@/lib/stats/dates';
import { analyticsData } from '@/lib/stats/analytics';
import { dashboardData, rankedEntities } from '@/lib/stats/queries';
import {
  calendarProfile,
  rankedEntityPage,
  timeBuckets,
  totalsAggregate,
  yearDayBuckets,
} from '@/lib/stats/aggregate';

/**
 * T-032 (§19): the read surfaces at the specification's own stated scale.
 *
 * Before H5 the dashboard, analytics, entity lists, and entity details each
 * materialised the user's whole matching history in Node. This fixture is
 * what makes that observable: one million events, and a p95 budget on the
 * four surfaces a user hits most.
 */

/** §19's stated target for the read surfaces. */
const P95_TARGET_MS = Number(process.env.PERF_P95_TARGET_MS ?? 1500);
const EVENTS = Number(process.env.PERF_EVENTS ?? 1_000_000);
const TRACKS = 5_000;
const ALBUMS = 500;
const ARTISTS = 2_000;
const ITERATIONS = Number(process.env.PERF_ITERATIONS ?? 10);

let container: StartedPostgreSqlContainer;
let database: PrismaClient;
let userId: string;
const measurements: Array<{ surface: string; p95: number; median: number }> =
  [];

/** The seeded window: EVENTS plays at 95s spacing, so a little over 3 years. */
const SEED_START = new Date('2023-01-01T00:00:00.000Z');
const SPACING_SECONDS = 95;
const seedEnd = () =>
  new Date(SEED_START.getTime() + EVENTS * SPACING_SECONDS * 1000);

function p95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  // Nearest-rank p95, which for ten samples is the second slowest.
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(0.95 * sorted.length) - 1,
  );
  return sorted[index]!;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function measure(surface: string, run: () => Promise<unknown>) {
  // One untimed pass so plan caching and buffer warm-up are not measured.
  await run();
  const samples: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const began = performance.now();
    await run();
    samples.push(performance.now() - began);
  }
  const result = { surface, p95: p95(samples), median: median(samples) };
  measurements.push(result);
  console.log(
    `[T-032] ${surface}: p95 ${result.p95.toFixed(0)}ms, median ${result.median.toFixed(0)}ms (${ITERATIONS} samples over ${EVENTS} events)`,
  );
  return result;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('resonance_perf')
    .withUsername('resonance')
    .withPassword('performance-test-only')
    .start();
  const rawUrl = container.getConnectionUri();
  execFileSync('./node_modules/.bin/prisma', ['migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: rawUrl },
    encoding: 'utf8',
  });

  // Seed with a client that has no statement_timeout: the bulk inserts are
  // legitimately long-running, unlike the reads under test.
  const seeder = new PrismaClient({ datasources: { db: { url: rawUrl } } });
  try {
    const user = await seeder.user.create({
      data: {
        status: 'ACTIVE',
        settings: {
          create: { timezone: 'America/New_York', weekStartsOn: 1 },
        },
      },
    });
    userId = user.id;
    const envelope = {
      version: 'v1',
      ciphertext: 'fixture',
      nonce: 'fixture',
      tag: 'fixture',
    };
    const account = await seeder.spotifyAccount.create({
      data: {
        userId: user.id,
        spotifyAccountId: 'perf-account',
        accessTokenEnvelope: envelope,
        refreshTokenEnvelope: envelope,
        accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
        refreshTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
        scopes: [],
      },
    });

    // Set-based seeding: generate_series in PostgreSQL rather than a million
    // round trips from Node.
    await seeder.$executeRaw`
      INSERT INTO artists (id, external_key, spotify_id, name, normalized_name, metadata_fetched_at, created_at, updated_at)
      SELECT gen_random_uuid(), 'spotify:perf-artist-' || i, 'perf-artist-' || i,
             'Artist ' || i, 'artist ' || i, now(), now(), now()
      FROM generate_series(1, ${ARTISTS}) i`;
    await seeder.$executeRaw`
      INSERT INTO albums (id, external_key, spotify_id, name, normalized_name, release_year, metadata_fetched_at, created_at, updated_at)
      SELECT gen_random_uuid(), 'spotify:perf-album-' || i, 'perf-album-' || i,
             'Album ' || i, 'album ' || i, 2020 + (i % 5), now(), now(), now()
      FROM generate_series(1, ${ALBUMS}) i`;
    await seeder.$executeRaw`
      INSERT INTO tracks (id, external_key, spotify_id, album_id, name, normalized_name, duration_ms, explicit, is_local, metadata_fetched_at, created_at, updated_at)
      SELECT gen_random_uuid(), 'spotify:perf-track-' || i, 'perf-track-' || i,
             a.id, 'Track ' || i, 'track ' || i, 120000 + (i % 60) * 1000,
             (i % 7 = 0), false, now(), now(), now()
      FROM generate_series(1, ${TRACKS}) i
      JOIN (
        SELECT row_number() OVER (ORDER BY external_key) - 1 AS n, id
        FROM albums WHERE external_key LIKE 'spotify:perf-album-%'
      ) a ON a.n = i % ${ALBUMS}`;
    // Two credited artists per track, so the artist-credit paths are exercised.
    await seeder.$executeRaw`
      INSERT INTO track_artists (track_id, artist_id, position)
      SELECT t.id, ar.id, p.position
      FROM (
        SELECT row_number() OVER (ORDER BY external_key) - 1 AS n, id
        FROM tracks WHERE external_key LIKE 'spotify:perf-track-%'
      ) t
      CROSS JOIN (VALUES (0), (1)) AS p(position)
      JOIN (
        SELECT row_number() OVER (ORDER BY external_key) - 1 AS n, id
        FROM artists WHERE external_key LIKE 'spotify:perf-artist-%'
      ) ar ON ar.n = (t.n * 2 + p.position) % ${ARTISTS}`;

    // The million events, in chunks so no single statement is enormous.
    const chunk = 250_000;
    for (let offset = 0; offset < EVENTS; offset += chunk) {
      const size = Math.min(chunk, EVENTS - offset);
      await seeder.$executeRaw`
        INSERT INTO listening_history (id, spotify_account_id, track_id, played_at, estimated_duration_ms, source, created_at)
        SELECT gen_random_uuid(), ${account.id}::uuid, t.id,
               ${SEED_START}::timestamptz + make_interval(secs => (${offset} + i) * ${SPACING_SECONDS}),
               t.duration_ms, 'SPOTIFY_API', now()
        FROM generate_series(0, ${size - 1}) i
        JOIN (
          SELECT row_number() OVER (ORDER BY external_key) - 1 AS n, id, duration_ms
          FROM tracks WHERE external_key LIKE 'spotify:perf-track-%'
        ) t ON t.n = (${offset} + i) % ${TRACKS}`;
    }
    await seeder.$executeRawUnsafe('ANALYZE');
    expect(
      await seeder.listeningHistory.count({
        where: { spotifyAccountId: account.id },
      }),
    ).toBe(EVENTS);
  } finally {
    await seeder.$disconnect();
  }

  // Measure through the same limited connection production uses.
  database = new PrismaClient({
    datasources: { db: { url: databaseUrlWithLimits(rawUrl, {}) } },
  });
});

afterAll(async () => {
  if (measurements.length) {
    console.log('[T-032] summary');
    for (const entry of measurements)
      console.log(
        `  ${entry.surface.padEnd(10)} p95 ${entry.p95.toFixed(0)}ms  median ${entry.median.toFixed(0)}ms  target ${P95_TARGET_MS}ms`,
      );
  }
  await database?.$disconnect();
  await container?.stop();
});

describe(`T-032 read surfaces at ${EVENTS} events`, () => {
  const settings = {
    timezone: 'America/New_York',
    weekStartsOn: 1,
    retentionDays: 3650,
  };
  const range = () =>
    resolveRange({
      preset: 'ALL_TIME',
      timezone: settings.timezone,
      weekStartsOn: settings.weekStartsOn,
      now: seedEnd(),
    });

  it('serves the dashboard within the p95 target', async () => {
    const resolved = range();
    const result = await measure('dashboard', () =>
      dashboardData(database, userId, resolved, undefined, 1),
    );
    expect(result.p95).toBeLessThanOrEqual(P95_TARGET_MS);
  });

  it('serves statistics within the p95 target', async () => {
    const resolved = range();
    const result = await measure('stats', () =>
      analyticsData(database, userId, resolved, 1, {
        rankingLimit: 25,
        distributionLimit: 10,
      }),
    );
    expect(result.p95).toBeLessThanOrEqual(P95_TARGET_MS);
  });

  it('serves entity search within the p95 target', async () => {
    const resolved = range();
    const result = await measure('search', () =>
      rankedEntities(
        database,
        userId,
        resolved,
        'artist',
        'artist 1',
        'plays',
        {
          limit: 25,
        },
      ),
    );
    expect(result.p95).toBeLessThanOrEqual(P95_TARGET_MS);
  });

  it('serves an export page within the p95 target', async () => {
    const resolved = range();
    const repository = new ApiRepository(database);
    const result = await measure('export', () =>
      repository.history(userId, {
        range: resolved,
        limit: 1_000,
        cursor: null,
      }),
    );
    expect(result.p95).toBeLessThanOrEqual(P95_TARGET_MS);
  });

  it('profiles each statistics aggregate individually', async () => {
    const resolved = range();
    const timings: Array<[string, number]> = [];
    const time = async (label: string, run: () => Promise<unknown>) => {
      await run();
      const began = performance.now();
      await run();
      timings.push([label, performance.now() - began]);
    };
    await time('totals', () => totalsAggregate(database, userId, resolved));
    await time('timeBuckets', () =>
      timeBuckets(database, userId, resolved, 'month', 1),
    );
    await time('calendarProfile', () =>
      calendarProfile(database, userId, resolved),
    );
    await time('yearDayBuckets', () =>
      yearDayBuckets(database, userId, resolved),
    );
    await time('rank:track', () =>
      rankedEntityPage(database, userId, resolved, 'track', { limit: 25 }),
    );
    await time('rank:album', () =>
      rankedEntityPage(database, userId, resolved, 'album', { limit: 25 }),
    );
    await time('rank:artist', () =>
      rankedEntityPage(database, userId, resolved, 'artist', { limit: 25 }),
    );
    for (const [label, elapsed] of timings)
      console.log(
        `[T-032 profile] ${label.padEnd(16)} ${elapsed.toFixed(0)}ms`,
      );
    expect(timings.length).toBe(7);
  });

  it('returns correct totals at scale, not just fast ones', async () => {
    const totals = (
      await dashboardData(database, userId, range(), undefined, 1)
    ).totals;
    expect(totals.plays).toBe(EVENTS);
    expect(totals.uniqueTracks).toBe(TRACKS);
    expect(totals.uniqueArtists).toBe(ARTISTS);
    expect(totals.uniqueAlbums).toBe(ALBUMS);
  });
});
