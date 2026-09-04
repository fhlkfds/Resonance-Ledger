// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { RangeFilter } from '@/components/filters/RangeFilter';
import {
  DesktopNavigation,
  MobileNavigation,
} from '@/components/layout/Navigation';
import { TrendChart } from '@/components/charts/TrendChart';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { historyQuerySchema } from '@/lib/api/history-query';

describe('dashboard components', () => {
  it('labels estimated listening time with the required caveat', () => {
    render(
      <KpiCard
        label="Estimated listening time"
        value="2h 10m"
        hint="Spotify provides no actual played milliseconds."
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Estimated listening time' }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Spotify provides no actual played milliseconds.'),
    ).toBeInTheDocument();
  });

  it('offers every preset and reports the effective timezone', () => {
    render(<RangeFilter value="LAST_30_DAYS" timezone="America/Chicago" />);
    expect(screen.getByLabelText('Date range')).toHaveValue('LAST_30_DAYS');
    expect(screen.getByText('All retained history')).toBeInTheDocument();
    expect(screen.getByText('Timezone: America/Chicago')).toBeInTheDocument();
  });

  it('provides desktop and mobile navigation in the required order', () => {
    render(
      <>
        <DesktopNavigation />
        <MobileNavigation />
      </>,
    );
    const primary = screen.getByRole('navigation', {
      name: 'Primary navigation',
    });
    expect(
      [...primary.querySelectorAll('a')].map((link) => link.textContent),
    ).toEqual([
      'Dashboard',
      'History',
      'Statistics',
      'Tracks',
      'Artists',
      'Albums',
    ]);
    expect(
      screen.getByRole('navigation', { name: 'Mobile navigation' }),
    ).toBeInTheDocument();
  });

  it('always exposes the chart values as an HTML table', () => {
    render(
      <TrendChart
        points={[
          { bucket: '2026-09-02', plays: 0, estimatedDurationMs: 0 },
          { bucket: '2026-09-03', plays: 2, estimatedDurationMs: 360_000 },
        ]}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Listening trend' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveTextContent('2026-09-02');
    expect(screen.getByRole('table')).toHaveTextContent('360000');
  });
});

describe('history and entity UI contracts', () => {
  it('renders detail breadcrumbs with an accessible current page', () => {
    render(
      <Breadcrumbs
        current="A retained track"
        parent="Tracks"
        parentHref="/tracks"
      />,
    );
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(breadcrumb).toBeVisible();
    expect(breadcrumb.querySelector('a[href="/tracks"]')).toHaveTextContent(
      'Tracks',
    );
    expect(breadcrumb.querySelector('a[href="/tracks"]')).toHaveAttribute(
      'href',
      '/tracks',
    );
    expect(screen.getByText('A retained track')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('strictly validates history filters and page limits', () => {
    expect(
      historyQuerySchema.parse({
        q: 'track',
        range: 'LAST_7_DAYS',
        explicit: 'true',
        limit: '100',
      }),
    ).toMatchObject({ explicit: true, limit: 100 });
    expect(() => historyQuerySchema.parse({ limit: '101' })).toThrow();
    expect(() => historyQuerySchema.parse({ surprise: 'value' })).toThrow();
  });
});
