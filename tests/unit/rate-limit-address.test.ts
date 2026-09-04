import { describe, expect, it } from 'vitest';
import {
  requestClientAddress,
  SHARED_ADDRESS_BUCKET,
} from '@/lib/api/rate-limit';

/**
 * H2: the auth limiter is 10 requests per address per 10 minutes. Deriving
 * that address from the leftmost X-Forwarded-For entry (or from X-Real-IP
 * with no trusted proxy at all) let one header buy an unlimited supply of
 * distinct buckets. Trusted hops append, so the attributable entry is counted
 * from the right.
 */

const requestWith = (headers: Record<string, string>) =>
  new Request('https://music.resonance.test/api/auth/spotify', { headers });

describe('rate limit client address', () => {
  it('indexes the hop exactly TRUST_PROXY places from the right', () => {
    const request = requestWith({
      'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4',
    });
    expect(requestClientAddress(request, 1)).toBe('4.4.4.4');
    expect(requestClientAddress(request, 2)).toBe('3.3.3.3');
    expect(requestClientAddress(request, 3)).toBe('2.2.2.2');
    expect(requestClientAddress(request, 4)).toBe('1.1.1.1');
  });

  it('cannot be steered by a forged leftmost entry', () => {
    // The attacker prepends whatever it likes; our own proxy appends the
    // address it actually saw, so the selected hop never moves.
    const keys = new Set(
      ['9.9.9.9', 'evil', '', '1.2.3.4, 5.6.7.8'].map((forged) =>
        requestClientAddress(
          requestWith({ 'x-forwarded-for': `${forged}, 203.0.113.7` }),
          1,
        ),
      ),
    );
    expect(keys).toEqual(new Set(['203.0.113.7']));
  });

  it('falls back to the shared bucket when the chain is too short', () => {
    const request = requestWith({ 'x-forwarded-for': '203.0.113.7' });
    expect(requestClientAddress(request, 2)).toBe(SHARED_ADDRESS_BUCKET);
    expect(requestClientAddress(request, 3)).toBe(SHARED_ADDRESS_BUCKET);
  });

  it('falls back to the shared bucket when the header is absent', () => {
    expect(requestClientAddress(requestWith({}), 1)).toBe(
      SHARED_ADDRESS_BUCKET,
    );
  });

  it('ignores both proxy headers when TRUST_PROXY is 0', () => {
    const request = requestWith({
      'x-forwarded-for': '9.9.9.9',
      'x-real-ip': '8.8.8.8',
    });
    expect(requestClientAddress(request, 0)).toBe(SHARED_ADDRESS_BUCKET);
    // A spoofed X-Real-IP must not be able to vary the key either.
    const forged = requestWith({ 'x-real-ip': '7.7.7.7' });
    expect(requestClientAddress(forged, 0)).toBe(
      requestClientAddress(request, 0),
    );
  });

  it('uses the socket address, not a header, when TRUST_PROXY is 0', () => {
    const request = requestWith({ 'x-real-ip': '8.8.8.8' });
    expect(requestClientAddress(request, 0, '198.51.100.4')).toBe(
      '198.51.100.4',
    );
  });

  it('prefers the trusted hop over the socket address behind a proxy', () => {
    const request = requestWith({
      'x-forwarded-for': '9.9.9.9, 203.0.113.7',
    });
    expect(requestClientAddress(request, 1, '10.0.0.1')).toBe('203.0.113.7');
  });

  it('handles a multi-proxy chain with padding and IPv6 hops', () => {
    const request = requestWith({
      'x-forwarded-for': '  2001:db8::1 ,  10.0.0.5 ,  10.0.0.6  ',
    });
    expect(requestClientAddress(request, 3)).toBe('2001:db8::1');
    expect(requestClientAddress(request, 1)).toBe('10.0.0.6');
  });

  it('rejects a non-address hop rather than keying on it', () => {
    const request = requestWith({
      'x-forwarded-for': '10.0.0.1, not-an-address',
    });
    expect(requestClientAddress(request, 1)).toBe(SHARED_ADDRESS_BUCKET);
  });

  it('keys distinct real clients to distinct buckets', () => {
    const first = requestClientAddress(
      requestWith({ 'x-forwarded-for': 'x, 203.0.113.1' }),
      1,
    );
    const second = requestClientAddress(
      requestWith({ 'x-forwarded-for': 'x, 203.0.113.2' }),
      1,
    );
    expect(first).not.toBe(second);
  });
});
