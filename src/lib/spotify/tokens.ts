import { z } from 'zod';
import { accountsOrigin } from './endpoints';

const refreshResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

export class InvalidGrantError extends Error {
  constructor() {
    super('Spotify authorization must be renewed');
    this.name = 'InvalidGrantError';
  }
}

export async function requestTokenRefresh(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
}) {
  const response = await (input.fetcher ?? fetch)(
    `${accountsOrigin()}/api/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    let code = '';
    try {
      code = z.object({ error: z.string() }).parse(JSON.parse(body)).error;
    } catch {
      // Provider error bodies are intentionally not propagated or logged.
    }
    if (code === 'invalid_grant') throw new InvalidGrantError();
    throw new Error(`Spotify refresh failed with status ${response.status}`);
  }
  return refreshResponseSchema.parse(JSON.parse(body));
}
