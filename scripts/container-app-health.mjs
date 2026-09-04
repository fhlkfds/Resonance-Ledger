/**
 * Container health probe for the app service.
 *
 * Runs inside the runtime image so the slim base needs no curl or wget.
 * Checks only that this process can serve and reach PostgreSQL; it never
 * calls Spotify and never prints configuration values.
 */
const port = process.env.PORT ?? '3000';
const timeout = AbortSignal.timeout(4000);

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: timeout,
    headers: { 'user-agent': 'resonance-ledger-healthcheck' },
  });
  if (!response.ok) {
    console.error(`health endpoint returned ${response.status}`);
    process.exit(1);
  }
  const body = await response.json();
  if (body?.status !== 'ok' || body?.db !== 'ok') {
    console.error('health endpoint reported a degraded state');
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(
    `health check failed: ${error instanceof Error ? error.name : 'unknown error'}`,
  );
  process.exit(1);
}
