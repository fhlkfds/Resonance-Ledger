import type { ReactNode } from 'react';
import { LazyAnalyticsChart } from './LazyAnalyticsChart';
import type { ChartKind, ChartSeries } from './AnalyticsChartCanvas';
import { formatMetric, type ChartMetric } from '@/lib/format';

export type ChartPanelProps = {
  title: string;
  kind: ChartKind;
  categories: string[];
  series: ChartSeries[];
  metric: ChartMetric;
  /** Header for the category column of the table alternative. */
  categoryHeading: string;
  description: string;
  note?: ReactNode;
  height?: number;
};

/**
 * A chart with an always-present HTML table alternative.
 *
 * The table is server-rendered inside a <details>, so the underlying values
 * stay reachable by keyboard and screen reader even before (or without) the
 * client chart bundle loading.
 */
export function ChartPanel({
  title,
  kind,
  categories,
  series,
  metric,
  categoryHeading,
  description,
  note,
  height,
}: ChartPanelProps) {
  // Derived from the title so server and client markup agree without a hook.
  const headingId = `chart-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-heading`;
  const empty =
    categories.length === 0 ||
    series.every((entry) => entry.values.every((value) => value === 0));

  return (
    <section
      className="rounded-2xl border border-white/10 bg-panel/80 p-5"
      aria-labelledby={headingId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        <span className="text-xs text-muted">
          {metric === 'plays' ? 'Plays' : 'Estimated listening time'}
        </span>
      </div>
      {note ? <p className="mt-1 text-xs text-muted">{note}</p> : null}

      {empty ? (
        <p className="py-12 text-center text-sm text-muted">
          No plays in this range.
        </p>
      ) : (
        <LazyAnalyticsChart
          kind={kind}
          categories={categories}
          series={series}
          description={description}
          asDuration={metric === 'estimatedDurationMs'}
          {...(height === undefined ? {} : { height })}
        />
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-accent">
          View chart data as a table
        </summary>
        <div
          className="mt-3 max-h-72 overflow-auto"
          role="region"
          aria-label={`${title} values`}
          tabIndex={0}
        >
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{description}</caption>
            <thead>
              <tr className="text-muted">
                <th scope="col" className="py-2">
                  {categoryHeading}
                </th>
                {series.map((entry) => (
                  <th scope="col" key={entry.name}>
                    {entry.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map((category, index) => (
                <tr key={category} className="border-t border-white/10">
                  <th scope="row" className="py-2 font-normal">
                    {category}
                  </th>
                  {series.map((entry) => (
                    <td key={entry.name}>
                      {formatMetric(entry.values[index] ?? 0, metric)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
