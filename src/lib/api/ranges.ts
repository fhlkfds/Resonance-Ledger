import { z } from 'zod';
import { ProblemError } from './errors';
import {
  resolveRange,
  type RangePreset,
  type ResolvedRange,
} from '@/lib/stats/dates';
import { retentionCutoff } from './retention-window';

export const rangeFields = {
  range: z
    .enum([
      'TODAY',
      'LAST_7_DAYS',
      'LAST_30_DAYS',
      'CURRENT_MONTH',
      'CURRENT_YEAR',
      'ALL_TIME',
      'CUSTOM',
    ])
    .default('LAST_30_DAYS'),
  from: z.string().optional(),
  to: z.string().optional(),
  tz: z.string().max(64).optional(),
};

export function normalizedRange(
  input: {
    range: RangePreset;
    from?: string;
    to?: string;
    tz?: string;
  },
  settings: {
    timezone: string;
    weekStartsOn: number;
    retentionDays?: number;
  },
  now = new Date(),
): ResolvedRange {
  if (input.range === 'CUSTOM' && (!input.from || !input.to))
    throw new ProblemError(
      400,
      'INVALID_RANGE',
      'Custom range requires from and to',
    );
  if (input.range !== 'CUSTOM' && (input.from || input.to))
    throw new ProblemError(
      400,
      'INVALID_RANGE',
      'Preset range cannot include from or to',
    );
  try {
    const resolved = resolveRange({
      preset: input.range,
      timezone: input.tz ?? settings.timezone,
      now,
      weekStartsOn: settings.weekStartsOn,
      ...(input.from ? { customFrom: input.from } : {}),
      ...(input.to ? { customTo: input.to } : {}),
    });
    // ALL_TIME resolves to an open-ended interval. Left unbounded it means
    // "scan everything ever stored", which is how one request could exhaust
    // memory; and it is a promise the retention job has already broken, since
    // anything past the cutoff is deleted. Bound it to the retained window.
    if (resolved.from === null)
      return {
        ...resolved,
        from: retentionCutoff(now, settings.retentionDays),
      };
    return resolved;
  } catch {
    throw new ProblemError(
      400,
      'INVALID_RANGE',
      'Date range or timezone is invalid',
    );
  }
}
