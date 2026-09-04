import { z } from 'zod';
import { ProblemError } from './errors';
import {
  resolveRange,
  type RangePreset,
  type ResolvedRange,
} from '@/lib/stats/dates';

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
  settings: { timezone: string; weekStartsOn: number },
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
    return resolveRange({
      preset: input.range,
      timezone: input.tz ?? settings.timezone,
      now,
      weekStartsOn: settings.weekStartsOn,
      ...(input.from ? { customFrom: input.from } : {}),
      ...(input.to ? { customTo: input.to } : {}),
    });
  } catch {
    throw new ProblemError(
      400,
      'INVALID_RANGE',
      'Date range or timezone is invalid',
    );
  }
}
