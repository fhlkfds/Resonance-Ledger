import { describe, expect, it } from 'vitest';
import { ProblemError } from '@/lib/api/errors';
import { jsonResponse, problemResponse } from '@/lib/api/responses';

describe('API responses', () => {
  it('wraps success data and request metadata', async () => {
    const response = jsonResponse({ ok: true }, 'request-1', {
      nextCursor: 'cursor',
    });
    await expect(response.json()).resolves.toEqual({
      data: { ok: true },
      meta: { nextCursor: 'cursor', requestId: 'request-1' },
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('uses application/problem+json without exposing unknown errors', async () => {
    const response = problemResponse(
      new Error('database password leaked'),
      'request-2',
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    expect(JSON.stringify(await response.json())).not.toContain(
      'database password leaked',
    );
  });

  it('returns stable application problem codes', async () => {
    const response = problemResponse(
      new ProblemError(400, 'BAD_INPUT', 'Invalid input'),
      'request-3',
    );
    await expect(response.json()).resolves.toMatchObject({
      status: 400,
      code: 'BAD_INPUT',
      requestId: 'request-3',
    });
  });
});
