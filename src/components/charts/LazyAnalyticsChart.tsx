'use client';

import dynamic from 'next/dynamic';
import type { AnalyticsChartProps } from './AnalyticsChartCanvas';

/** ECharts touches the DOM directly, so it is loaded client-side only. */
const Canvas = dynamic(() => import('./AnalyticsChartCanvas'), {
  ssr: false,
  loading: () => (
    <div
      className="h-72 w-full animate-pulse rounded-xl bg-white/5"
      aria-hidden="true"
    />
  ),
});

export function LazyAnalyticsChart(props: AnalyticsChartProps) {
  return <Canvas {...props} />;
}
