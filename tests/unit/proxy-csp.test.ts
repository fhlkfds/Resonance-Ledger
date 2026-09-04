import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

/**
 * H1: Next discovers the nonce by parsing the Content-Security-Policy off the
 * *request* headers. Setting the header only on the response leaves every
 * script bundle unnonced, and because 'strict-dynamic' makes 'self' inert,
 * all client JS is blocked. These assert the header lands on both sides and
 * that the two copies agree on one nonce.
 */

function run(path = '/login') {
  const request = new NextRequest(`https://music.resonance.test${path}`);
  const response = proxy(request);
  // NextResponse.next({ request: { headers } }) conveys the rewritten request
  // headers to the renderer as x-middleware-request-* entries.
  return {
    response,
    responseCsp: response.headers.get('content-security-policy'),
  };
}

describe('proxy content security policy', () => {
  it('sets the CSP on the request headers Next parses for the nonce', () => {
    const { response } = run();
    const overrides = (
      response.headers.get('x-middleware-override-headers') ?? ''
    )
      .split(',')
      .map((entry) => entry.trim().toLowerCase());
    expect(overrides).toContain('content-security-policy');
    expect(
      response.headers.get('x-middleware-request-content-security-policy'),
    ).toContain('nonce-');
  });

  it('uses the same nonce in the request CSP, response CSP, and x-nonce', () => {
    const { response, responseCsp } = run();
    const nonce = response.headers.get('x-middleware-request-x-nonce');
    expect(nonce).toBeTruthy();
    expect(responseCsp).toContain(`'nonce-${nonce}'`);
    expect(
      response.headers.get('x-middleware-request-content-security-policy'),
    ).toContain(`'nonce-${nonce}'`);
  });

  it('issues a fresh nonce per request', () => {
    const first = run().response.headers.get('x-middleware-request-x-nonce');
    const second = run().response.headers.get('x-middleware-request-x-nonce');
    expect(first).not.toBe(second);
  });

  it('keeps strict-dynamic, which is why the request header matters', () => {
    const { responseCsp } = run();
    expect(responseCsp).toContain("'strict-dynamic'");
  });
});
