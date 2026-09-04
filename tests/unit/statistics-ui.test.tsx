// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartPanel } from '@/components/charts/ChartPanel';
import { StatisticsFilter } from '@/components/filters/StatisticsFilter';
import { formatDuration, formatMetric } from '@/lib/format';

// ECharts needs a real canvas, so the lazy chart is stubbed. The table
// alternative is server-rendered and must stand on its own regardless.
vi.mock('@/components/charts/LazyAnalyticsChart', () => ({
  LazyAnalyticsChart: ({ description }: { description: string }) => (
    <div role="img" aria-label={description} />
  ),
}));

// Vitest runs without globals, so React Testing Library's automatic
// cleanup is not registered; unmount explicitly to isolate each test.
afterEach(cleanup);

const categories = ['2026-03-07', '2026-03-08'];
const series = [{ name: 'Plays', values: [3, 1] }];

describe('chart accessibility', () => {
  it('exposes an accessible chart image and an equivalent table', () => {
    render(
      <ChartPanel
        title="Listening over time"
        kind="line"
        metric="plays"
        categoryHeading="Bucket"
        categories={categories}
        series={series}
        description="Plays by day bucket in America/New_York."
      />,
    );

    expect(
      screen.getByRole('img', {
        name: 'Plays by day bucket in America/New_York.',
      }),
    ).toBeInTheDocument();

    // The section is named by its heading, so the chart is reachable by landmark.
    expect(
      screen.getByRole('region', { name: 'Listening over time' }),
    ).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(
      within(table).getByRole('columnheader', { name: 'Bucket' }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole('rowheader', { name: '2026-03-07' }),
    ).toBeInTheDocument();
    expect(within(table).getByText('3')).toBeInTheDocument();
  });

  it('keeps the table scroll region focusable for keyboard users', () => {
    render(
      <ChartPanel
        title="Activity by hour"
        kind="column"
        metric="plays"
        categoryHeading="Local hour"
        categories={categories}
        series={series}
        description="Plays grouped by local hour."
      />,
    );
    const region = screen.getByRole('region', {
      name: 'Activity by hour values',
    });
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('formats duration series as hours and minutes in the table', () => {
    render(
      <ChartPanel
        title="Listening time"
        kind="line"
        metric="estimatedDurationMs"
        categoryHeading="Bucket"
        categories={['2026-03-07']}
        series={[{ name: 'Estimated listening time', values: [5_400_000] }]}
        description="Estimated listening time by day."
      />,
    );
    expect(screen.getByText('1h 30m')).toBeInTheDocument();
  });

  it('reports an empty range without rendering a chart', () => {
    render(
      <ChartPanel
        title="Top artists"
        kind="bar"
        metric="plays"
        categoryHeading="Artist"
        categories={[]}
        series={[{ name: 'Plays', values: [] }]}
        description="Highest ranked artists by plays."
      />,
    );
    expect(screen.getByText('No plays in this range.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('surfaces the collaboration caveat as a chart note', () => {
    render(
      <ChartPanel
        title="Top artists"
        kind="bar"
        metric="plays"
        categoryHeading="Artist"
        categories={['Ada']}
        series={[{ name: 'Plays', values: [3] }]}
        description="Highest ranked artists by plays."
        note="Each play credits every listed artist, so collaboration totals overlap."
      />,
    );
    expect(
      screen.getByText(
        'Each play credits every listed artist, so collaboration totals overlap.',
      ),
    ).toBeInTheDocument();
  });
});

describe('statistics filter', () => {
  it('keeps range, metric, and granularity in a GET form', () => {
    const { container } = render(
      <StatisticsFilter
        range="LAST_7_DAYS"
        metric="estimatedDurationMs"
        granularity="week"
        timezone="Europe/Berlin"
      />,
    );
    expect(container.querySelector('form')).toHaveAttribute('method', 'get');
    expect(screen.getByLabelText('Date range')).toHaveValue('LAST_7_DAYS');
    expect(screen.getByLabelText('Metric')).toHaveValue('estimatedDurationMs');
    expect(screen.getByLabelText('Granularity')).toHaveValue('week');
    expect(screen.getByText('Timezone: Europe/Berlin')).toBeInTheDocument();
  });

  it('names the metric "Estimated listening time", never "exact"', () => {
    render(
      <StatisticsFilter
        range="TODAY"
        metric="plays"
        granularity="auto"
        timezone="UTC"
      />,
    );
    expect(screen.getByText('Estimated listening time')).toBeInTheDocument();
    expect(screen.queryByText(/exact/i)).not.toBeInTheDocument();
  });
});

describe('metric formatting', () => {
  it('formats durations and counts distinctly', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(90_000)).toBe('1m');
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(5_430_000)).toBe('1h 30m');
    expect(formatMetric(1234, 'plays')).toBe('1,234');
    expect(formatMetric(3_600_000, 'estimatedDurationMs')).toBe('1h 0m');
  });
});
