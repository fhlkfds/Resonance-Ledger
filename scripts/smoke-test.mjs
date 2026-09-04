#!/usr/bin/env node
/**
 * Read-only post-deployment smoke test.
 *
 * Checks that a deployed installation serves its public surface and reports a
 * healthy database. It never starts OAuth, never mutates history, and never
 * prints a configuration value, so it is safe to run unattended.
 *
 * Usage: node scripts/smoke-test.mjs [baseUrl]
 * Exit codes: 0 all checks passed, 1 one or more failed.
 */
const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const results = [];

async function check(name, run) {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : 'unknown failure',
    });
  }
}

const get = (path, options = {}) =>
  fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
    ...options,
  });

await check('health responds 200 with a safe schema', async () => {
  const started = Date.now();
  const response = await get('/api/health');
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const body = await response.json();
  for (const field of ['status', 'version', 'db', 'requestId']) {
    if (!(field in body)) throw new Error(`missing field ${field}`);
  }
  if (body.status !== 'ok' || body.db !== 'ok')
    throw new Error('reported a degraded state');
  for (const leaked of ['password', 'secret', 'token', 'DATABASE_URL']) {
    if (JSON.stringify(body).toLowerCase().includes(leaked.toLowerCase()))
      throw new Error(`response mentions ${leaked}`);
  }
  return `${Date.now() - started}ms, version ${body.version}`;
});

await check('login page is publicly reachable', async () => {
  const response = await get('/login');
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  return '200';
});

for (const path of ['/privacy', '/terms']) {
  await check(`${path} stays reachable`, async () => {
    const response = await get(path);
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    return '200';
  });
}

await check('private page redirects an anonymous visitor', async () => {
  const response = await get('/');
  if (![302, 303, 307, 308].includes(response.status))
    throw new Error(`expected a redirect, got ${response.status}`);
  const location = response.headers.get('location') ?? '';
  if (!location.includes('/login'))
    throw new Error('redirect does not target /login');
  return `${response.status} to /login`;
});

await check('private API rejects an anonymous caller', async () => {
  const response = await get('/api/me');
  if (response.status !== 401)
    throw new Error(`expected 401, got ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/problem+json'))
    throw new Error('error is not application/problem+json');
  return '401 problem+json';
});

await check('security headers are present', async () => {
  const response = await get('/login');
  const required = {
    'content-security-policy': "frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  for (const [header, expected] of Object.entries(required)) {
    const value = response.headers.get(header);
    if (!value) throw new Error(`missing ${header}`);
    if (!value.includes(expected))
      throw new Error(`${header} does not contain ${expected}`);
  }
  return 'CSP, nosniff, referrer-policy';
});

await check('every script tag carries the CSP nonce', async () => {
  // H1: with 'strict-dynamic' in script-src, 'self' is ignored, so an
  // unnonced bundle is a blocked bundle and no client component works.
  const response = await get('/login');
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  const csp = response.headers.get('content-security-policy') ?? '';
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  if (!nonce) throw new Error('CSP carries no nonce');
  const html = await response.text();
  const tags = html.match(/<script\b[^>]*>/g) ?? [];
  if (tags.length === 0) throw new Error('page rendered no script tags');
  const unnonced = tags.filter((tag) => !tag.includes(`nonce="${nonce}"`));
  if (unnonced.length)
    throw new Error(
      `${unnonced.length} of ${tags.length} script tags lack the CSP nonce`,
    );
  return `${tags.length} script tags nonced`;
});

await check(
  'a state-changing route refuses a cross-origin caller',
  async () => {
    const response = await get('/api/sync', {
      method: 'POST',
      headers: { origin: 'https://attacker.invalid' },
    });
    if (![401, 403].includes(response.status))
      throw new Error(`expected 401 or 403, got ${response.status}`);
    return String(response.status);
  },
);

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  const label = result.ok ? '[OK]  ' : '[ERROR]';
  console.log(
    `${label} ${result.name}${result.detail ? ` (${result.detail})` : ''}`,
  );
}
console.log(
  failed.length
    ? `[ERROR] ${failed.length} of ${results.length} smoke checks failed`
    : `[OK]   all ${results.length} smoke checks passed against ${baseUrl}`,
);
process.exit(failed.length ? 1 : 0);
