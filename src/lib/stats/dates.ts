/**
 * Calendar arithmetic in a user's IANA timezone.
 *
 * Timestamps are stored in UTC; this module is the only place that converts
 * between UTC instants and local calendar boundaries. Offsets come from
 * Intl.DateTimeFormat, which resolves against the ICU copy of the IANA
 * timezone database, so DST transitions are handled by the platform.
 */

export type Granularity = 'hour' | 'day' | 'week' | 'month' | 'year';

export type RangePreset =
  | 'TODAY'
  | 'LAST_7_DAYS'
  | 'LAST_30_DAYS'
  | 'CURRENT_MONTH'
  | 'CURRENT_YEAR'
  | 'ALL_TIME'
  | 'CUSTOM';

/** Half-open UTC interval [from, to). `from` is null only for ALL_TIME. */
export type ResolvedRange = {
  preset: RangePreset;
  from: Date | null;
  to: Date;
  timezone: string;
};

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timezone: string): boolean {
  if (!/^[A-Za-z0-9+_\-/]{1,64}$/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(timezone: string): string {
  if (!isValidTimeZone(timezone))
    throw new RangeError(`Unknown IANA timezone: ${timezone}`);
  return timezone;
}

/** Wall-clock calendar fields for a UTC instant, as observed in `timezone`. */
export function utcToZonedParts(instant: Date, timezone: string): ZonedParts {
  const parts = partsFormatter(timezone).formatToParts(instant);
  const lookup: Record<string, string> = {};
  for (const part of parts) lookup[part.type] = part.value;
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
    weekday: WEEKDAY_INDEX[lookup.weekday ?? 'Sun'] ?? 0,
  };
}

/** Milliseconds to add to UTC to obtain local wall-clock time at `instant`. */
export function timeZoneOffsetMs(instant: Date, timezone: string): number {
  const parts = utcToZonedParts(instant, timezone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert local wall-clock fields to the UTC instant they denote.
 *
 * Two cases are ambiguous and both resolve deterministically:
 *
 * - Fall-back overlap, where the wall-clock time occurs twice. The earlier
 *   instant (still on the pre-transition offset) is chosen.
 * - Spring-forward gap, where the wall-clock time never occurs. Neither
 *   candidate round-trips, so the time is shifted forward by the gap, which
 *   matches the convention used by Temporal, java.time, and moment-timezone.
 */
export function zonedPartsToUtc(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const nominal = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = timeZoneOffsetMs(new Date(nominal), timezone);
  const firstGuess = nominal - firstOffset;
  const secondOffset = timeZoneOffsetMs(new Date(firstGuess), timezone);
  if (secondOffset === firstOffset) return new Date(firstGuess);

  const secondGuess = nominal - secondOffset;
  if (timeZoneOffsetMs(new Date(secondGuess), timezone) === secondOffset)
    return new Date(secondGuess);
  return new Date(firstGuess);
}

/** Local midnight starting the day that contains `instant`. */
export function startOfLocalDay(instant: Date, timezone: string): Date {
  const parts = utcToZonedParts(instant, timezone);
  return zonedPartsToUtc(timezone, parts.year, parts.month, parts.day);
}

export function addLocalDays(
  instant: Date,
  timezone: string,
  days: number,
): Date {
  const parts = utcToZonedParts(instant, timezone);
  return zonedPartsToUtc(timezone, parts.year, parts.month, parts.day + days);
}

export function startOfLocalWeek(
  instant: Date,
  timezone: string,
  weekStartsOn: number,
): Date {
  const parts = utcToZonedParts(instant, timezone);
  const shift = (parts.weekday - weekStartsOn + 7) % 7;
  return zonedPartsToUtc(timezone, parts.year, parts.month, parts.day - shift);
}

export function startOfLocalMonth(instant: Date, timezone: string): Date {
  const parts = utcToZonedParts(instant, timezone);
  return zonedPartsToUtc(timezone, parts.year, parts.month, 1);
}

export function startOfLocalYear(instant: Date, timezone: string): Date {
  const parts = utcToZonedParts(instant, timezone);
  return zonedPartsToUtc(timezone, parts.year, 1, 1);
}

export function startOfBucket(
  instant: Date,
  timezone: string,
  granularity: Granularity,
  weekStartsOn: number,
): Date {
  switch (granularity) {
    case 'hour': {
      const parts = utcToZonedParts(instant, timezone);
      return zonedPartsToUtc(
        timezone,
        parts.year,
        parts.month,
        parts.day,
        parts.hour,
      );
    }
    case 'day':
      return startOfLocalDay(instant, timezone);
    case 'week':
      return startOfLocalWeek(instant, timezone, weekStartsOn);
    case 'month':
      return startOfLocalMonth(instant, timezone);
    case 'year':
      return startOfLocalYear(instant, timezone);
  }
}

export function nextBucket(
  bucketStart: Date,
  timezone: string,
  granularity: Granularity,
  weekStartsOn: number,
): Date {
  const parts = utcToZonedParts(bucketStart, timezone);
  switch (granularity) {
    case 'hour':
      return new Date(bucketStart.getTime() + 3_600_000);
    case 'day':
      return zonedPartsToUtc(timezone, parts.year, parts.month, parts.day + 1);
    case 'week':
      return zonedPartsToUtc(timezone, parts.year, parts.month, parts.day + 7);
    case 'month':
      return zonedPartsToUtc(timezone, parts.year, parts.month + 1, 1);
    case 'year':
      return zonedPartsToUtc(timezone, parts.year + 1, 1, 1);
  }
  return startOfBucket(
    new Date(bucketStart.getTime() + 86_400_000),
    timezone,
    granularity,
    weekStartsOn,
  );
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** Stable local label identifying a bucket, e.g. "2026-03-08" or "2026-03". */
export function bucketLabel(
  bucketStart: Date,
  timezone: string,
  granularity: Granularity,
): string {
  const parts = utcToZonedParts(bucketStart, timezone);
  switch (granularity) {
    case 'hour':
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}`;
    case 'day':
    case 'week':
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    case 'month':
      return `${parts.year}-${pad(parts.month)}`;
    case 'year':
      return String(parts.year);
  }
}

/** Every bucket start in [from, to), so series can be zero-filled. */
export function enumerateBuckets(
  from: Date,
  to: Date,
  timezone: string,
  granularity: Granularity,
  weekStartsOn: number,
): Date[] {
  const buckets: Date[] = [];
  let cursor = startOfBucket(from, timezone, granularity, weekStartsOn);
  // Guard against pathological ranges producing unbounded series.
  const limit = 20_000;
  while (cursor < to && buckets.length < limit) {
    buckets.push(cursor);
    const next = nextBucket(cursor, timezone, granularity, weekStartsOn);
    if (next <= cursor) break;
    cursor = next;
  }
  return buckets;
}

/** Day for <=90 days, week for <=2 years, month otherwise (spec §4). */
export function adaptiveGranularity(from: Date | null, to: Date): Granularity {
  if (!from) return 'month';
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days <= 90) return 'day';
  if (days <= 731) return 'week';
  return 'month';
}

/**
 * Resolve a preset or custom range to a half-open UTC interval.
 *
 * `customTo` is the user's inclusive end date; it is advanced to the next
 * local midnight so the stored interval stays half-open.
 */
export function resolveRange(input: {
  preset: RangePreset;
  timezone: string;
  now: Date;
  weekStartsOn: number;
  customFrom?: string;
  customTo?: string;
}): ResolvedRange {
  const { preset, timezone, now } = input;
  assertTimeZone(timezone);
  const today = startOfLocalDay(now, timezone);
  const tomorrow = addLocalDays(today, timezone, 1);

  switch (preset) {
    case 'TODAY':
      return { preset, from: today, to: tomorrow, timezone };
    case 'LAST_7_DAYS':
      return {
        preset,
        from: addLocalDays(today, timezone, -6),
        to: tomorrow,
        timezone,
      };
    case 'LAST_30_DAYS':
      return {
        preset,
        from: addLocalDays(today, timezone, -29),
        to: tomorrow,
        timezone,
      };
    case 'CURRENT_MONTH':
      return {
        preset,
        from: startOfLocalMonth(now, timezone),
        to: tomorrow,
        timezone,
      };
    case 'CURRENT_YEAR':
      return {
        preset,
        from: startOfLocalYear(now, timezone),
        to: tomorrow,
        timezone,
      };
    case 'ALL_TIME':
      return { preset, from: null, to: tomorrow, timezone };
    case 'CUSTOM': {
      if (!input.customFrom || !input.customTo)
        throw new RangeError('custom range requires both from and to');
      const from = parseLocalDate(input.customFrom, timezone);
      const inclusiveEnd = parseLocalDate(input.customTo, timezone);
      const to = addLocalDays(inclusiveEnd, timezone, 1);
      if (from >= to) throw new RangeError('custom range is inverted or empty');
      return { preset, from, to, timezone };
    }
  }
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a YYYY-MM-DD calendar date to local midnight in `timezone`. */
export function parseLocalDate(value: string, timezone: string): Date {
  const match = DATE_ONLY.exec(value);
  if (!match) throw new RangeError('date must be formatted YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31)
    throw new RangeError('date is not a valid calendar date');
  const instant = zonedPartsToUtc(timezone, year, month, day);
  const roundTrip = utcToZonedParts(instant, timezone);
  // Rejects impossible dates such as 2026-02-30 that Date.UTC would roll over.
  if (roundTrip.day !== day || roundTrip.month !== month)
    throw new RangeError('date is not a valid calendar date');
  return instant;
}

/**
 * The immediately preceding interval of equal elapsed duration.
 * Undefined for retained all-time, where no equal prior interval exists.
 */
export function priorPeriod(
  range: ResolvedRange,
): { from: Date; to: Date } | null {
  if (!range.from) return null;
  const span = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - span), to: range.from };
}
