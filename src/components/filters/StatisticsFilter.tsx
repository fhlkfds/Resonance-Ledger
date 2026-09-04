const ranges = [
  ['TODAY', 'Today'],
  ['LAST_7_DAYS', 'Last 7 days'],
  ['LAST_30_DAYS', 'Last 30 days'],
  ['CURRENT_MONTH', 'Current month'],
  ['CURRENT_YEAR', 'Current year'],
  ['ALL_TIME', 'All retained history'],
] as const;

const metrics = [
  ['plays', 'Plays'],
  ['estimatedDurationMs', 'Estimated listening time'],
] as const;

const granularities = [
  ['auto', 'Automatic'],
  ['hour', 'Hour'],
  ['day', 'Day'],
  ['week', 'Week'],
  ['month', 'Month'],
  ['year', 'Year'],
] as const;

const field = 'rounded-xl border border-white/15 bg-panel px-3 py-2 text-ink';

/**
 * Plain GET form so filters live in the URL and survive refresh, back
 * navigation, and sharing within the same authenticated account.
 */
export function StatisticsFilter({
  range,
  compare,
  metric,
  granularity,
  years,
  timezone,
}: {
  range: string;
  compare: string;
  metric: string;
  granularity: string;
  years: string;
  timezone: string;
}) {
  return (
    <form className="flex flex-wrap items-end gap-3" method="get">
      <label className="grid gap-1 text-sm text-muted">
        Date range
        <select name="range" defaultValue={range} className={field}>
          {ranges.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm text-muted">
        Compare with
        <select name="compare" defaultValue={compare} className={field}>
          <option value="">None</option>
          {ranges.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm text-muted">
        Metric
        <select name="metric" defaultValue={metric} className={field}>
          {metrics.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm text-muted">
        Years
        <input
          className={field}
          defaultValue={years}
          inputMode="numeric"
          maxLength={100}
          name="years"
          pattern="[0-9]{4}(,[0-9]{4})*"
          placeholder="2024,2025,2026"
        />
      </label>
      <label className="grid gap-1 text-sm text-muted">
        Granularity
        <select name="granularity" defaultValue={granularity} className={field}>
          {granularities.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <input type="hidden" name="tz" value={timezone} />
      <button
        className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:border-accent"
        type="submit"
      >
        Apply
      </button>
      <p className="pb-2 text-xs text-muted">Timezone: {timezone}</p>
    </form>
  );
}
