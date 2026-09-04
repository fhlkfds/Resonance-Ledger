import { PrismaClient } from '@prisma/client';
import { expect, test } from '@playwright/test';

const database = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.E2E_DATABASE_URL ??
        'postgresql://resonance:resonance-e2e-password-long@127.0.0.1:5432/resonance_e2e?schema=public',
    },
  },
});

test.afterAll(() => database.$disconnect());

test('login redirects to the consent gate before contacting the provider', async ({
  page,
}) => {
  await page.goto('/api/auth/spotify');
  await expect(page).toHaveURL(/\/login\?error=consent_required/);
});

test('fake OAuth covers dashboard, pagination, export, mobile, charts, and logout', async ({
  page,
}) => {
  const existing = await database.spotifyAccount.findUnique({
    where: { spotifyAccountId: 'resonance-e2e-account' },
  });
  if (existing) await database.user.delete({ where: { id: existing.userId } });

  await page.goto('/login');
  await page.getByRole('checkbox', { name: /I have read and accept/ }).check();
  const consent = await page.request.post('/api/consent', {
    form: { consent: 'accepted' },
    headers: { origin: 'http://127.0.0.1:3100' },
    maxRedirects: 0,
  });
  expect(consent.status()).toBe(303);
  await page.goto('/api/auth/spotify');
  await expect(page).toHaveURL('http://127.0.0.1:3100/');
  await expect(
    page.getByRole('heading', { name: 'No plays in this range' }),
  ).toBeVisible();

  const account = await database.spotifyAccount.findUniqueOrThrow({
    where: { spotifyAccountId: 'resonance-e2e-account' },
  });
  const track = await database.track.create({
    data: {
      externalKey: `spotify:e2e-track-${account.id}`,
      spotifyId: `e2e-track-${account.id}`,
      name: 'Pagination Fixture',
      normalizedName: 'pagination fixture',
      durationMs: 180_000,
      metadataFetchedAt: new Date(),
    },
  });
  const now = Date.now();
  await database.listeningHistory.createMany({
    data: Array.from({ length: 55 }, (_, index) => ({
      spotifyAccountId: account.id,
      trackId: track.id,
      playedAt: new Date(now - index * 60_000),
      estimatedDurationMs: 180_000,
    })),
  });

  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Listening summary' })
      .getByText('55', { exact: true }),
  ).toBeVisible();
  await page.goto('/history');
  await expect(page.getByRole('link', { name: 'Next page' })).toBeVisible();
  await page.getByRole('link', { name: 'Next page' }).click();
  await expect(page.getByText('Pagination Fixture').first()).toBeVisible();

  const foreignUser = await database.user.create({
    data: { status: 'ACTIVE', settings: { create: {} } },
  });
  const envelope = {
    version: 'v1',
    ciphertext: 'fixture',
    nonce: 'fixture',
    tag: 'fixture',
  };
  const foreignAccount = await database.spotifyAccount.create({
    data: {
      userId: foreignUser.id,
      spotifyAccountId: `foreign-${account.id}`,
      accessTokenEnvelope: envelope,
      refreshTokenEnvelope: envelope,
      accessTokenExpiresAt: new Date(now + 86_400_000),
      refreshTokenExpiresAt: new Date(now + 86_400_000),
      scopes: [],
    },
  });
  const foreignTrack = await database.track.create({
    data: {
      externalKey: `spotify:foreign-${account.id}`,
      spotifyId: `foreign-${account.id}`,
      name: 'Foreign Track',
      normalizedName: 'foreign track',
      durationMs: 1,
      metadataFetchedAt: new Date(),
      history: {
        create: {
          spotifyAccountId: foreignAccount.id,
          playedAt: new Date(now),
          estimatedDurationMs: 1,
        },
      },
    },
  });
  expect(
    (await page.request.get(`/api/tracks/${foreignTrack.id}`)).status(),
  ).toBe(404);
  expect(
    (
      await page.request.get(
        '/api/stats?metrics[]=not-a-metric&years=not-a-year',
      )
    ).status(),
  ).toBe(400);
  const stats = await page.request.get(
    '/api/stats?metrics[]=plays&years[]=2025&years[]=2026&dimensions[]=yearOverYear&dimensions[]=hourWeekday',
  );
  expect(stats.status()).toBe(200);
  const statsBody = await stats.json();
  expect(statsBody.data.metrics).toEqual(['plays']);
  expect(statsBody.data.series.yearOverYear).toHaveLength(2);
  expect(statsBody.data.series.hourWeekday).toHaveLength(7);

  for (const [method, path, data] of [
    ['post', '/api/sync', undefined],
    ['patch', '/api/settings', { timezone: 'UTC' }],
    ['delete', '/api/account/spotify', { confirmation: 'DELETE' }],
  ] as const) {
    const response = await page.request[method](path, data ? { data } : {});
    expect(response.status()).toBe(403);
  }

  const formulaTrack = await database.track.create({
    data: {
      externalKey: `spotify:formula-${account.id}`,
      spotifyId: `formula-${account.id}`,
      name: '=SUM(A1)',
      normalizedName: '=sum(a1)',
      durationMs: 1,
      metadataFetchedAt: new Date(),
      history: {
        create: {
          spotifyAccountId: account.id,
          playedAt: new Date(now + 1),
          estimatedDurationMs: 1,
        },
      },
    },
  });
  const csv = await page.request.get(
    `/api/export?type=history&format=csv&trackId=${formulaTrack.id}&range=ALL_TIME`,
  );
  expect(await csv.text()).toContain('"\'=SUM(A1)"');

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export filtered CSV' }).click();
  expect((await download).suggestedFilename()).toBe('resonance-ledger.csv');

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/statistics?range=LAST_30_DAYS&years=2025,2026');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const tableToggle = page
    .getByText('View chart data as a table', { exact: true })
    .first();
  await tableToggle.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('region', { name: /Listening over time values/ }),
  ).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

  // H1: a real onClick round trip. If the CSP nonce does not reach the
  // rendered script tags, 'strict-dynamic' blocks every bundle, the page
  // never hydrates, and this click produces no status text at all.
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByRole('status').filter({ hasText: /\S/ })).toHaveCount(
    1,
    { timeout: 10_000 },
  );

  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'resonance_csrf',
  )!.value;
  const logout = await page.request.post('/api/auth/logout', {
    headers: {
      origin: 'http://127.0.0.1:3100',
      'x-csrf-token': csrf,
    },
  });
  expect(logout.status()).toBe(204);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('every rendered script tag carries the CSP nonce', async ({ page }) => {
  // H1: Next stamps the nonce onto its script tags only when it can read the
  // Content-Security-Policy off the *request* headers.
  const response = await page.goto('/login');
  const csp = response!.headers()['content-security-policy'] ?? '';
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  expect(nonce, 'CSP carries a nonce').toBeTruthy();
  const unnonced = await page.evaluate(
    (expected) =>
      [...document.querySelectorAll('script')].filter(
        (tag) => tag.getAttribute('nonce') !== expected,
      ).length,
    nonce,
  );
  expect(await page.locator('script').count()).toBeGreaterThan(0);
  expect(unnonced).toBe(0);
});
