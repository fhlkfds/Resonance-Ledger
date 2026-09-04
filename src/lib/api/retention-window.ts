/**
 * The retained window, shared by the read path and the retention job.
 *
 * §16 discloses two retention numbers: the per-user `retentionDays` setting
 * and the operator-level DATA_RETENTION_DAYS floor. The effective window is
 * the shorter of the two -- an operator cannot promise 90 days in the privacy
 * policy and then retain 730 because a user asked for it.
 */

/** The specification default, used when a value is missing or nonsensical. */
export const DEFAULT_RETENTION_DAYS = 730;

/**
 * Read straight from process.env rather than the full environment schema so
 * this stays usable from pages and unit tests without a complete production
 * configuration. Callers may pass the value explicitly instead.
 */
export function operatorRetentionDays(
  environment: Partial<Record<string, string>> = process.env,
): number {
  const parsed = Number(environment.DATA_RETENTION_DAYS);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RETENTION_DAYS;
}

/**
 * The effective retention window in days.
 *
 * A non-positive user value would mean perpetual retention, which the policy
 * forbids, so it falls back to the default rather than disabling deletion.
 */
export function effectiveRetentionDays(
  userRetentionDays: number | null | undefined,
  operatorDays: number = operatorRetentionDays(),
): number {
  const userDays =
    typeof userRetentionDays === 'number' && userRetentionDays > 0
      ? userRetentionDays
      : DEFAULT_RETENTION_DAYS;
  return Math.min(userDays, operatorDays);
}

/** True when the operator floor is shorter than what the user asked for. */
export function isClampedByOperator(
  userRetentionDays: number | null | undefined,
  operatorDays: number = operatorRetentionDays(),
): boolean {
  return (
    typeof userRetentionDays === 'number' &&
    userRetentionDays > 0 &&
    userRetentionDays > operatorDays
  );
}

/** The oldest instant still inside the retained window. */
export function retentionCutoff(
  now: Date,
  userRetentionDays: number | null | undefined,
  operatorDays: number = operatorRetentionDays(),
): Date {
  const days = effectiveRetentionDays(userRetentionDays, operatorDays);
  return new Date(now.getTime() - days * 86_400_000);
}
