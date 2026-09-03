import { describe, expect, it, vi } from 'vitest';
import { InvalidGrantError, requestTokenRefresh } from '@/lib/spotify/tokens';

const input = {
  refreshToken: 'old-refresh',
  clientId: 'client',
  clientSecret: 'secret',
};

describe('Spotify token refresh', () => {
  it('accepts responses with or without a replacement refresh token', async () => {
    const withReplacement = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    const withoutReplacement = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    await expect(
      requestTokenRefresh({ ...input, fetcher: withReplacement }),
    ).resolves.toMatchObject({ refresh_token: 'new-refresh' });
    await expect(
      requestTokenRefresh({ ...input, fetcher: withoutReplacement }),
    ).resolves.not.toHaveProperty('refresh_token');
  });

  it('classifies invalid_grant without exposing the response body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          access_token: 'must-not-leak',
        }),
        { status: 400 },
      ),
    );
    await expect(
      requestTokenRefresh({ ...input, fetcher }),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });
});
