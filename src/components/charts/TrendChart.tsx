'use client';

import dynamic from 'next/dynamic';
import type { TrendPoint } from './EChartCanvas';

const Chart = dynamic(() => import('./EChartCanvas'), { ssr: false });

export function TrendChart({ points }: { points: TrendPoint[] }) {
  return (
    <section
      className="rounded-2xl border border-white/10 bg-panel/80 p-5"
      aria-labelledby="trend-heading"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="trend-heading" className="text-lg font-semibold">
          Listening trend
        </h2>
        <span className="text-xs text-muted">Plays</span>
      </div>
      <Chart points={points} metric="plays" />
      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-accent">
          View chart data as a table
        </summary>
        <div
          className="mt-3 max-h-64 overflow-auto"
          role="region"
          aria-label="Listening trend values"
          tabIndex={0}
        >
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-muted">
                <th className="py-2">Bucket</th>
                <th>Plays</th>
                <th>Estimated listening time (ms)</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.bucket} className="border-t border-white/10">
                  <td className="py-2">{point.bucket}</td>
                  <td>{point.plays}</td>
                  <td>{point.estimatedDurationMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
