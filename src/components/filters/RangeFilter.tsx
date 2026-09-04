const ranges = [
  ['TODAY', 'Today'],
  ['LAST_7_DAYS', 'Last 7 days'],
  ['LAST_30_DAYS', 'Last 30 days'],
  ['CURRENT_MONTH', 'Current month'],
  ['CURRENT_YEAR', 'Current year'],
  ['ALL_TIME', 'All retained history'],
] as const;

export function RangeFilter({
  value,
  timezone,
}: {
  value: string;
  timezone: string;
}) {
  return (
    <form className="flex flex-wrap items-end gap-3" method="get">
      <label className="grid gap-1 text-sm text-muted">
        Date range
        <select
          name="range"
          defaultValue={value}
          className="rounded-xl border border-white/15 bg-panel px-3 py-2 text-ink"
        >
          {ranges.map(([range, label]) => (
            <option key={range} value={range}>
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
