import { describe, expect, it } from 'vitest';
import { normalizedRange } from '@/lib/api/ranges';
import {
  DEFAULT_RETENTION_DAYS,
  effectiveRetentionDays,
  isClampedByOperator,
  retentionCutoff,
} from '@/lib/api/retention-window';

/**
 * H5: ALL_TIME resolved to an open-ended interval, so every all-time read was
 * "scan everything ever stored". M1: the operator-level DATA_RETENTION_DAYS
 * is disclosed in the privacy policy but was never applied, so a user setting
 * could quietly exceed what the operator promised.
 */

const now = new Date('2026-09-04T12:00:00.000Z');
const day = 86_400_000;

describe('effective retention window', () => {
  it('takes the shorter of the user setting and the operator floor', () => {
    expect(effectiveRetentionDays(730, 90)).toBe(90);
    expect(effectiveRetentionDays(30, 90)).toBe(30);
    expect(effectiveRetentionDays(90, 90)).toBe(90);
  });

  it('falls back to the default rather than retaining forever', () => {
    expect(effectiveRetentionDays(0, 3650)).toBe(DEFAULT_RETENTION_DAYS);
    expect(effectiveRetentionDays(-1, 3650)).toBe(DEFAULT_RETENTION_DAYS);
    expect(effectiveRetentionDays(undefined, 3650)).toBe(
      DEFAULT_RETENTION_DAYS,
    );
  });

  it('reports when the operator floor is what bites', () => {
    expect(isClampedByOperator(730, 90)).toBe(true);
    expect(isClampedByOperator(30, 90)).toBe(false);
    expect(isClampedByOperator(0, 90)).toBe(false);
  });

  it('derives the cutoff from the effective window', () => {
    expect(retentionCutoff(now, 730, 90)).toEqual(
      new Date(now.getTime() - 90 * day),
    );
  });
});

describe('ALL_TIME is bounded by the retained window', () => {
  const settings = { timezone: 'UTC', weekStartsOn: 1, retentionDays: 365 };

  it('gives ALL_TIME a concrete lower bound', () => {
    const range = normalizedRange({ range: 'ALL_TIME' }, settings, now);
    expect(range.from).not.toBeNull();
    expect(range.from).toEqual(new Date(now.getTime() - 365 * day));
  });

  it('honours the operator floor when it is shorter', () => {
    process.env.DATA_RETENTION_DAYS = '90';
    try {
      const range = normalizedRange({ range: 'ALL_TIME' }, settings, now);
      expect(range.from).toEqual(new Date(now.getTime() - 90 * day));
    } finally {
      delete process.env.DATA_RETENTION_DAYS;
    }
  });

  it('leaves a preset range untouched', () => {
    const range = normalizedRange({ range: 'LAST_7_DAYS' }, settings, now);
    expect(range.from).toEqual(new Date('2026-08-29T00:00:00.000Z'));
    expect(range.preset).toBe('LAST_7_DAYS');
  });

  it('still reports the ALL_TIME preset to the client', () => {
    expect(normalizedRange({ range: 'ALL_TIME' }, settings, now).preset).toBe(
      'ALL_TIME',
    );
  });
});
