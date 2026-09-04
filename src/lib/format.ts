/** Presentation helpers. APIs return raw integers; formatting happens here. */

/** Human duration from milliseconds, e.g. "12h 34m" or "34m". */
export function formatDuration(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  return hours ? `${hours.toLocaleString()}h ${minutes}m` : `${minutes}m`;
}

export type ChartMetric = 'plays' | 'estimatedDurationMs';

export const metricLabel: Record<ChartMetric, string> = {
  plays: 'Plays',
  estimatedDurationMs: 'Estimated listening time',
};

/** Format one metric value for display, respecting its unit. */
export function formatMetric(value: number, metric: ChartMetric): string {
  return metric === 'estimatedDurationMs'
    ? formatDuration(value)
    : value.toLocaleString();
}

export const ESTIMATE_CAVEAT =
  "Spotify provides no actual played milliseconds. This estimate sums each track's full duration.";
