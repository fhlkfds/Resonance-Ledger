import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  decodeOffsetCursor,
  encodeCursor,
  encodeOffsetCursor,
} from '@/lib/api/pagination';
import { normalizedRange } from '@/lib/api/ranges';
import { validateCsrfToken, validateSameOrigin } from '@/lib/auth/csrf';
import { hashSecret } from '@/lib/auth/oauth-state';
import { databaseUrlWithLimits } from '@/lib/db/client';
import { neutralizeCsvFormula } from '@/app/api/export/route';
import {
  addLocalDays,
  enumerateBuckets,
  parseLocalDate,
  priorPeriod,
  resolveRange,
  utcToZonedParts,
} from '@/lib/stats/dates';

describe('opaque pagination', () => {
  it('round trips a time cursor and rejects malformed input', () => {
    const cursor = {
      at: '2026-09-03T12:00:00.000Z',
      id: '11111111-1111-4111-8111-111111111111',
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(() => decodeCursor('not-json')).toThrow('Cursor is invalid');
  });

  it('round trips a bounded entity offset', () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(50))).toBe(50);
    expect(() =>
      decodeOffsetCursor(Buffer.from('{"offset":-1}').toString('base64url')),
    ).toThrow();
  });
});

describe('date ranges and DST', () => {
  const zone = 'America/Chicago';

  it('converts an inclusive custom leap date to a half-open interval', () => {
    const range = resolveRange({
      preset: 'CUSTOM',
      timezone: zone,
      now: new Date('2026-09-03T12:00:00Z'),
      weekStartsOn: 1,
      customFrom: '2024-02-29',
      customTo: '2024-02-29',
    });
    expect(range.from?.toISOString()).toBe('2024-02-29T06:00:00.000Z');
    expect(range.to.toISOString()).toBe('2024-03-01T06:00:00.000Z');
  });

  it('uses 23-hour and 25-hour local days at DST transitions', () => {
    const spring = parseLocalDate('2026-03-08', zone);
    const springNext = addLocalDays(spring, zone, 1);
    const fall = parseLocalDate('2026-11-01', zone);
    const fallNext = addLocalDays(fall, zone, 1);
    expect(springNext.getTime() - spring.getTime()).toBe(23 * 3_600_000);
    expect(fallNext.getTime() - fall.getTime()).toBe(25 * 3_600_000);
    expect(
      enumerateBuckets(spring, addLocalDays(spring, zone, 3), zone, 'day', 1),
    ).toHaveLength(3);
  });

  it('returns local parts and an equal elapsed prior period', () => {
    expect(
      utcToZonedParts(new Date('2026-09-03T05:30:00Z'), zone),
    ).toMatchObject({ year: 2026, month: 9, day: 3, hour: 0, minute: 30 });
    const range = resolveRange({
      preset: 'LAST_7_DAYS',
      timezone: zone,
      now: new Date('2026-09-03T12:00:00Z'),
      weekStartsOn: 1,
    });
    const prior = priorPeriod(range)!;
    expect(prior.to).toEqual(range.from);
    expect(prior.to.getTime() - prior.from.getTime()).toBe(
      range.to.getTime() - range.from!.getTime(),
    );
  });

  it('rejects invalid or conflicting ranges', () => {
    expect(() => parseLocalDate('2026-02-30', zone)).toThrow();
    expect(() =>
      normalizedRange(
        { range: 'TODAY', from: '2026-01-01' },
        { timezone: zone, weekStartsOn: 1 },
      ),
    ).toThrow();
    expect(() =>
      normalizedRange(
        { range: 'CUSTOM', from: '2026-01-01' },
        { timezone: zone, weekStartsOn: 1 },
      ),
    ).toThrow();
  });
});

describe('state-changing request controls', () => {
  it('requires exact Origin and Host plus the synchronizer token', () => {
    const valid = new Request('https://listen.test/api/settings', {
      headers: { Origin: 'https://listen.test', Host: 'listen.test' },
    });
    const crossOrigin = new Request('https://listen.test/api/settings', {
      headers: { Origin: 'https://evil.test', Host: 'listen.test' },
    });
    expect(validateSameOrigin(valid, 'https://listen.test')).toBe(true);
    expect(validateSameOrigin(crossOrigin, 'https://listen.test')).toBe(false);
    expect(validateCsrfToken('csrf-value', hashSecret('csrf-value'))).toBe(
      true,
    );
    expect(validateCsrfToken('wrong', hashSecret('csrf-value'))).toBe(false);
  });

  it.each(['=cmd()', '+SUM(A1)', '-10+20', '@danger'])(
    'neutralizes CSV formula cell %s',
    (value) => {
      expect(neutralizeCsvFormula(value)).toBe(`'${value}`);
    },
  );
});

/**
 * H5/M9 (§18): without a bounded pool Prisma sizes it from the CPU count, and
 * without a statement_timeout one heavy query holds its connection until the
 * server gives up -- which is how a single authenticated request became a
 * denial of service.
 */
describe('database connection limits', () => {
  const url = 'postgresql://resonance:secret@postgres:5432/resonance';

  it('applies a bounded pool and a statement timeout by default', () => {
    const applied = new URL(databaseUrlWithLimits(url, {}));
    expect(applied.searchParams.get('connection_limit')).toBe('10');
    expect(applied.searchParams.get('pool_timeout')).toBe('10');
    expect(applied.searchParams.get('options')).toBe(
      '-c statement_timeout=10000',
    );
  });

  it('honours operator overrides', () => {
    const applied = new URL(
      databaseUrlWithLimits(url, {
        DATABASE_POOL_SIZE: '4',
        DATABASE_STATEMENT_TIMEOUT_MS: '2500',
      }),
    );
    expect(applied.searchParams.get('connection_limit')).toBe('4');
    expect(applied.searchParams.get('options')).toBe(
      '-c statement_timeout=2500',
    );
  });

  it('never overwrites a value the operator already set in the URL', () => {
    const applied = new URL(
      databaseUrlWithLimits(
        `${url}?connection_limit=25&options=-c%20statement_timeout%3D1000`,
        {},
      ),
    );
    expect(applied.searchParams.get('connection_limit')).toBe('25');
    expect(applied.searchParams.get('options')).toBe(
      '-c statement_timeout=1000',
    );
  });

  it('falls back to the defaults on a nonsense value', () => {
    const applied = new URL(
      databaseUrlWithLimits(url, {
        DATABASE_POOL_SIZE: 'lots',
        DATABASE_STATEMENT_TIMEOUT_MS: '-1',
      }),
    );
    expect(applied.searchParams.get('connection_limit')).toBe('10');
    expect(applied.searchParams.get('options')).toBe(
      '-c statement_timeout=10000',
    );
  });
});
