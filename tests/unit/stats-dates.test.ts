import { describe, expect, it } from 'vitest';
import {
  adaptiveGranularity,
  bucketLabel,
  enumerateBuckets,
  isValidTimeZone,
  parseLocalDate,
  priorPeriod,
  resolveRange,
  startOfBucket,
  startOfLocalWeek,
  timeZoneOffsetMs,
  utcToZonedParts,
  zonedPartsToUtc,
} from '@/lib/stats/dates';

const NEW_YORK = 'America/New_York';
const KATHMANDU = 'Asia/Kathmandu'; // UTC+05:45, a non-hour offset
const HOUR = 3_600_000;

describe('timezone validation', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone(NEW_YORK)).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('"; DROP TABLE users;--')).toBe(false);
  });
});

describe('T-016 date filtering: offsets and conversion', () => {
  it('reports the correct offset either side of spring forward', () => {
    // 2026-03-08 02:00 local is skipped in the United States.
    expect(timeZoneOffsetMs(new Date('2026-03-08T06:00:00Z'), NEW_YORK)).toBe(
      -5 * HOUR,
    );
    expect(timeZoneOffsetMs(new Date('2026-03-08T08:00:00Z'), NEW_YORK)).toBe(
      -4 * HOUR,
    );
  });

  it('handles a 45-minute offset zone', () => {
    expect(timeZoneOffsetMs(new Date('2026-06-01T00:00:00Z'), KATHMANDU)).toBe(
      5 * HOUR + 45 * 60_000,
    );
    const parts = utcToZonedParts(new Date('2026-06-01T00:00:00Z'), KATHMANDU);
    expect([parts.hour, parts.minute]).toEqual([5, 45]);
  });

  it('round-trips local midnight through UTC', () => {
    const midnight = zonedPartsToUtc(NEW_YORK, 2026, 7, 4);
    expect(midnight.toISOString()).toBe('2026-07-04T04:00:00.000Z');
    expect(utcToZonedParts(midnight, NEW_YORK).day).toBe(4);
  });

  it('resolves a spring-forward gap deterministically', () => {
    // 02:30 does not exist on 2026-03-08; it maps to the instant the clock
    // jumps to rather than throwing or silently drifting a day.
    const gap = zonedPartsToUtc(NEW_YORK, 2026, 3, 8, 2, 30);
    expect(gap.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('picks the earlier instant during a fall-back overlap', () => {
    // 01:30 occurs twice on 2026-11-01; the first (EDT, -04:00) is chosen.
    const overlap = zonedPartsToUtc(NEW_YORK, 2026, 11, 1, 1, 30);
    expect(overlap.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
});

describe('T-016 DST-correct day buckets', () => {
  it('keeps one bucket for the 23-hour spring-forward day', () => {
    const buckets = enumerateBuckets(
      zonedPartsToUtc(NEW_YORK, 2026, 3, 7),
      zonedPartsToUtc(NEW_YORK, 2026, 3, 10),
      NEW_YORK,
      'day',
      1,
    );
    expect(buckets.map((date) => bucketLabel(date, NEW_YORK, 'day'))).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
    // The short day is 23 hours long, proving the boundary moved with DST.
    expect(buckets[2]!.getTime() - buckets[1]!.getTime()).toBe(23 * HOUR);
  });

  it('keeps one bucket for the 25-hour fall-back day', () => {
    const buckets = enumerateBuckets(
      zonedPartsToUtc(NEW_YORK, 2026, 10, 31),
      zonedPartsToUtc(NEW_YORK, 2026, 11, 3),
      NEW_YORK,
      'day',
      1,
    );
    expect(buckets.map((date) => bucketLabel(date, NEW_YORK, 'day'))).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(buckets[2]!.getTime() - buckets[1]!.getTime()).toBe(25 * HOUR);
  });

  it('assigns an instant inside the DST shift to the right local day', () => {
    const justAfterShift = new Date('2026-03-08T07:30:00Z'); // 03:30 EDT
    expect(
      bucketLabel(
        startOfBucket(justAfterShift, NEW_YORK, 'day', 1),
        NEW_YORK,
        'day',
      ),
    ).toBe('2026-03-08');
  });
});

describe('T-016 leap day', () => {
  it('enumerates February 29 in a leap year', () => {
    const labels = enumerateBuckets(
      zonedPartsToUtc('UTC', 2028, 2, 28),
      zonedPartsToUtc('UTC', 2028, 3, 1),
      'UTC',
      'day',
      1,
    ).map((date) => bucketLabel(date, 'UTC', 'day'));
    expect(labels).toEqual(['2028-02-28', '2028-02-29']);
  });

  it('omits February 29 in a common year', () => {
    const labels = enumerateBuckets(
      zonedPartsToUtc('UTC', 2026, 2, 28),
      zonedPartsToUtc('UTC', 2026, 3, 1),
      'UTC',
      'day',
      1,
    ).map((date) => bucketLabel(date, 'UTC', 'day'));
    expect(labels).toEqual(['2026-02-28']);
  });

  it('rejects a date that does not exist', () => {
    expect(() => parseLocalDate('2026-02-30', 'UTC')).toThrow(RangeError);
    expect(() => parseLocalDate('2026-13-01', 'UTC')).toThrow(RangeError);
    expect(() => parseLocalDate('not-a-date', 'UTC')).toThrow(RangeError);
    expect(parseLocalDate('2028-02-29', 'UTC').toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
});

describe('week and month boundaries', () => {
  it('honours the configured week start', () => {
    const wednesday = new Date('2026-09-02T12:00:00Z');
    expect(
      bucketLabel(startOfLocalWeek(wednesday, 'UTC', 1), 'UTC', 'week'),
    ).toBe('2026-08-31'); // Monday
    expect(
      bucketLabel(startOfLocalWeek(wednesday, 'UTC', 0), 'UTC', 'week'),
    ).toBe('2026-08-30'); // Sunday
  });

  it('enumerates month buckets across a year boundary', () => {
    const labels = enumerateBuckets(
      zonedPartsToUtc('UTC', 2025, 11, 1),
      zonedPartsToUtc('UTC', 2026, 2, 1),
      'UTC',
      'month',
      1,
    ).map((date) => bucketLabel(date, 'UTC', 'month'));
    expect(labels).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});

describe('T-016 range resolution', () => {
  const settings = { timezone: NEW_YORK, weekStartsOn: 1 } as const;
  const now = new Date('2026-09-03T18:00:00Z'); // 14:00 in New York

  it('builds a half-open interval for today', () => {
    const range = resolveRange({ preset: 'TODAY', now, ...settings });
    expect(range.from?.toISOString()).toBe('2026-09-03T04:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-09-04T04:00:00.000Z');
  });

  it('spans seven local days inclusive of today', () => {
    const range = resolveRange({ preset: 'LAST_7_DAYS', now, ...settings });
    expect(range.from?.toISOString()).toBe('2026-08-28T04:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-09-04T04:00:00.000Z');
  });

  it('advances a user-entered end date to the next local midnight', () => {
    const range = resolveRange({
      preset: 'CUSTOM',
      now,
      ...settings,
      customFrom: '2026-09-01',
      customTo: '2026-09-02',
    });
    expect(range.from?.toISOString()).toBe('2026-09-01T04:00:00.000Z');
    // The inclusive end date 09-02 becomes exclusive 09-03T00:00 local.
    expect(range.to.toISOString()).toBe('2026-09-03T04:00:00.000Z');
  });

  it('rejects an inverted custom range', () => {
    expect(() =>
      resolveRange({
        preset: 'CUSTOM',
        now,
        ...settings,
        customFrom: '2026-09-05',
        customTo: '2026-09-01',
      }),
    ).toThrow(RangeError);
  });

  it('requires both bounds for a custom range', () => {
    expect(() =>
      resolveRange({
        preset: 'CUSTOM',
        now,
        ...settings,
        customFrom: '2026-09-01',
      }),
    ).toThrow(RangeError);
  });

  it('leaves all-time open at the start', () => {
    const range = resolveRange({ preset: 'ALL_TIME', now, ...settings });
    expect(range.from).toBeNull();
    expect(priorPeriod(range)).toBeNull();
  });
});

describe('prior period and adaptive granularity', () => {
  it('mirrors an equal-length preceding interval', () => {
    const range = resolveRange({
      preset: 'LAST_7_DAYS',
      now: new Date('2026-09-03T18:00:00Z'),
      timezone: 'UTC',
      weekStartsOn: 1,
    });
    const prior = priorPeriod(range)!;
    expect(prior.to).toEqual(range.from);
    expect(prior.to.getTime() - prior.from.getTime()).toBe(
      range.to.getTime() - range.from!.getTime(),
    );
  });

  it('selects day, week, then month as the span grows', () => {
    const to = new Date('2026-09-03T00:00:00Z');
    const daysAgo = (days: number) =>
      new Date(to.getTime() - days * 86_400_000);
    expect(adaptiveGranularity(daysAgo(30), to)).toBe('day');
    expect(adaptiveGranularity(daysAgo(90), to)).toBe('day');
    expect(adaptiveGranularity(daysAgo(91), to)).toBe('week');
    expect(adaptiveGranularity(daysAgo(731), to)).toBe('week');
    expect(adaptiveGranularity(daysAgo(732), to)).toBe('month');
    expect(adaptiveGranularity(null, to)).toBe('month');
  });
});

describe('T-017 empty ranges', () => {
  it('returns an empty bucket list when the interval is degenerate', () => {
    const instant = zonedPartsToUtc('UTC', 2026, 5, 1);
    expect(enumerateBuckets(instant, instant, 'UTC', 'day', 1)).toEqual([]);
  });

  it('still yields the containing bucket for a sub-day interval', () => {
    const from = new Date('2026-05-01T06:00:00Z');
    const to = new Date('2026-05-01T09:00:00Z');
    expect(enumerateBuckets(from, to, 'UTC', 'day', 1)).toHaveLength(1);
    expect(enumerateBuckets(from, to, 'UTC', 'hour', 1)).toHaveLength(3);
  });
});
