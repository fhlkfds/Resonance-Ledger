import { createServer } from 'node:http';

createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:4010');
  if (url.pathname === '/authorize') {
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'fixture-code');
    callback.searchParams.set('state', url.searchParams.get('state'));
    response.writeHead(302, { location: callback.toString() }).end();
    return;
  }
  response.setHeader('content-type', 'application/json');
  if (url.pathname === '/api/token') {
    response.end(
      JSON.stringify({
        access_token: 'fixture-access-token',
        refresh_token: 'fixture-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'user-read-private user-read-recently-played',
      }),
    );
    return;
  }
  if (url.pathname === '/v1/me') {
    response.end(
      JSON.stringify({
        // Mirrors the real /v1/me body: the immutable key is `id` only.
        id: 'resonance-e2e-account',
        display_name: 'E2E Listener',
      }),
    );
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: 'fixture_not_found' }));
}).listen(4010, '127.0.0.1');
