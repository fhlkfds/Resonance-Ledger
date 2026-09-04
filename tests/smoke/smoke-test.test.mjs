import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const run = promisify(execFile);
let server;
let baseUrl;

before(async () => {
  server = createServer((request, response) => {
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; frame-ancestors 'none'",
    );
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    if (request.url === '/api/health') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          status: 'ok',
          version: 'test',
          db: 'ok',
          requestId: 'smoke-fixture',
        }),
      );
    } else if (request.url === '/api/me') {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/problem+json');
      response.end('{}');
    } else if (request.url === '/api/sync') {
      response.statusCode = 403;
      response.end();
    } else if (request.url === '/') {
      response.statusCode = 307;
      response.setHeader('location', '/login');
      response.end();
    } else {
      response.end('ok');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('the unattended smoke script accepts the safe public contract', async () => {
  const { stdout } = await run(process.execPath, [
    'scripts/smoke-test.mjs',
    baseUrl,
  ]);
  assert.match(stdout, /all 8 smoke checks passed/);
});

test('the unattended smoke script exits non-zero on a bad target', async () => {
  await assert.rejects(
    run(process.execPath, ['scripts/smoke-test.mjs', 'http://127.0.0.1:1']),
    (error) => error.code === 1 && /smoke checks failed/.test(error.stdout),
  );
});
