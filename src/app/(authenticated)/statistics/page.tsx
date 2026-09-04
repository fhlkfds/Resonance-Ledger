import { ChartPanel } from '@/components/charts/ChartPanel';
import { StatisticsFilter } from '@/components/filters/StatisticsFilter';
import { requireSession } from '@/lib/auth/request-session';
import { database } from '@/lib/db/client';
import { analyticsData } from '@/lib/stats/analytics';
import {
  resolveRange,
  type Granularity,
  type RangePreset,
} from '@/lib/stats/dates';
import {
  ESTIMATE_CAVEAT,
  formatDuration,
  metricLabel,
  type ChartMetric,
} from '@/lib/format';

const validRanges = new Set<RangePreset>([
  'TODAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
  'CURRENT_MONTH',
  'CURRENT_YEAR',
  'ALL_TIME',
]);
const validGranularities = new Set<Granularity>([
  'hour',
  'day',
  'week',
  'month',
  'year',
]);

type Point = { bucket: string; plays: number; estimatedDurationMs: number };
type Ranked = {
  id: string;
  name: string;
  plays: number;
  estimatedDurationMs: number;
};

const points = (values: Point[], metric: ChartMetric) => ({
  categories: values.map((point) => point.bucket),
  series: [
    { name: metricLabel[metric], values: values.map((point) => point[metric]) },
  ],
});

const ranked = (values: Ranked[], metric: ChartMetric) => ({
  categories: values.map((entry) => entry.name),
  series: [
    { name: metricLabel[metric], values: values.map((entry) => entry[metric]) },
  ],
});

export default async function StatisticsPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    metric?: string;
    granularity?: string;
  }>;
}) {
  const session = await requireSession();
  const settings = await database.userSettings.findUniqueOrThrow({
    where: { userId: session.userId },
  });
  const parameters = await searchParams;

  const preset =
    parameters.range && validRanges.has(parameters.range as RangePreset)
      ? (parameters.range as RangePreset)
      : (settings.defaultRange as RangePreset);
  const metric: ChartMetric =
    parameters.metric === 'estimatedDurationMs'
      ? 'estimatedDurationMs'
      : 'plays';
  const requestedGranularity =
    parameters.granularity &&
    validGranularities.has(parameters.granularity as Granularity)
      ? (parameters.granularity as Granularity)
      : undefined;

  const range = resolveRange({
    preset,
    timezone: settings.timezone,
    weekStartsOn: settings.weekStartsOn,
    now: new Date(),
  });
  const data = await analyticsData(
    database,
    session.userId,
    range,
    settings.weekStartsOn,
    {
      ...(requestedGranularity ? { granularity: requestedGranularity } : {}),
      rankingLimit: 10,
      distributionLimit: 8,
    },
  );

  const time = points(data.time, metric);
  const hourly = points(data.hourly, metric);
  const weekday = points(data.weekday, metric);
  const month = points(data.month, metric);
  const artists = ranked(data.rankings.artists, metric);
  const albums = ranked(data.rankings.albums, metric);
  const tracks = ranked(data.rankings.tracks, metric);
  const yearOverYear = data.yearOverYear.filter((year) => year.points.length);

  return (
    <div className="space-y-8">
      <header className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
        <div>
          <p className="text-sm text-accent">Statistics</p>
          <h1 className="mt-1 text-4xl font-semibold tracking-tight">
            Listening analysis
          </h1>
        </div>
        <StatisticsFilter
          range={preset}
          metric={metric}
          granularity={requestedGranularity ?? 'auto'}
          timezone={settings.timezone}
        />
      </header>

      <section
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Range totals"
      >
        <Total label="Total plays" value={data.totals.plays.toLocaleString()} />
        <Total
          label="Estimated listening time"
          value={formatDuration(data.totals.estimatedDurationMs)}
          hint={ESTIMATE_CAVEAT}
        />
        <Total
          label="Unique tracks"
          value={data.totals.uniqueTracks.toLocaleString()}
        />
        <Total
          label="Artist play credits"
          value={data.totals.artistPlayCredits.toLocaleString()}
          hint="Each credited artist receives one credit per play, so collaborative totals overlap and must not be summed as plays."
        />
      </section>

      <dl className="rounded-2xl border border-white/10 bg-panel/60 p-5 text-sm">
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-muted">
          <span>
            <dt className="inline font-medium text-ink">Interval:</dt>{' '}
            <dd className="inline">
              {data.bucketDefinitions.interval} half-open
            </dd>
          </span>
          <span>
            <dt className="inline font-medium text-ink">Granularity:</dt>{' '}
            <dd className="inline">{data.bucketDefinitions.granularity}</dd>
          </span>
          <span>
            <dt className="inline font-medium text-ink">Timezone:</dt>{' '}
            <dd className="inline">{data.bucketDefinitions.timezone}</dd>
          </span>
          <span>
            <dt className="inline font-medium text-ink">Leap day:</dt>{' '}
            <dd className="inline">{data.bucketDefinitions.leapDay}</dd>
          </span>
        </div>
      </dl>

      <ChartPanel
        title="Listening over time"
        kind="line"
        metric={metric}
        categoryHeading="Bucket"
        categories={time.categories}
        series={time.series}
        description={`${metricLabel[metric]} by ${data.bucketDefinitions.granularity} bucket in ${range.timezone}.`}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartPanel
          title="Activity by hour"
          kind="column"
          metric={metric}
          categoryHeading="Local hour"
          categories={hourly.categories}
          series={hourly.series}
          description={`${metricLabel[metric]} grouped by local hour 0 to 23 in ${range.timezone}.`}
        />
        <ChartPanel
          title="Activity by weekday"
          kind="column"
          metric={metric}
          categoryHeading="Weekday"
          categories={weekday.categories}
          series={weekday.series}
          description={`${metricLabel[metric]} grouped by local weekday in ${range.timezone}.`}
          note={`Week starts on ${weekday.categories[0] ?? 'Monday'}.`}
        />
      </div>

      <ChartPanel
        title="Activity by month"
        kind="column"
        metric={metric}
        categoryHeading="Month"
        categories={month.categories}
        series={month.series}
        description={`${metricLabel[metric]} grouped by calendar month in ${range.timezone}.`}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartPanel
          title="Top artists"
          kind="bar"
          metric={metric}
          categoryHeading="Artist"
          categories={artists.categories}
          series={artists.series}
          description={`Highest ranked artists by ${metricLabel[metric].toLowerCase()}.`}
          note="Each play credits every listed artist, so collaboration totals overlap."
        />
        <ChartPanel
          title="Top albums"
          kind="bar"
          metric={metric}
          categoryHeading="Album"
          categories={albums.categories}
          series={albums.series}
          description={`Highest ranked albums by ${metricLabel[metric].toLowerCase()}.`}
        />
      </div>

      <ChartPanel
        title="Top tracks"
        kind="bar"
        metric={metric}
        categoryHeading="Track"
        categories={tracks.categories}
        series={tracks.series}
        description={`Highest ranked tracks by ${metricLabel[metric].toLowerCase()}.`}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartPanel
          title="Artist distribution"
          kind="donut"
          metric="plays"
          categoryHeading="Artist"
          categories={data.distributions.artists.items.map((item) => item.name)}
          series={[
            {
              name: 'Play credits',
              values: data.distributions.artists.items.map(
                (item) => item.plays,
              ),
            },
          ]}
          description="Share of artist play credits, top artists plus Other."
          note={`Denominator: ${data.distributions.artists.denominator.toLocaleString()} artist play credits.`}
        />
        <ChartPanel
          title="Album distribution"
          kind="donut"
          metric="plays"
          categoryHeading="Album"
          categories={data.distributions.albums.items.map((item) => item.name)}
          series={[
            {
              name: 'Plays',
              values: data.distributions.albums.items.map((item) => item.plays),
            },
          ]}
          description="Share of album plays, top albums plus Other."
          note={`Denominator: ${data.distributions.albums.denominator.toLocaleString()} plays with an album.`}
        />
      </div>

      {yearOverYear.length > 1 ? (
        <ChartPanel
          title="Year over year"
          kind="line"
          metric={metric}
          categoryHeading="Day of year"
          categories={[
            ...new Set(
              yearOverYear.flatMap((year) =>
                year.points.map((point) => point.bucket),
              ),
            ),
          ].sort()}
          series={yearOverYear.map((year) => ({
            name: String(year.year),
            values: [
              ...new Set(
                yearOverYear.flatMap((entry) =>
                  entry.points.map((point) => point.bucket),
                ),
              ),
            ]
              .sort()
              .map(
                (bucket) =>
                  year.points.find((point) => point.bucket === bucket)?.[
                    metric
                  ] ?? 0,
              ),
          }))}
          description={`${metricLabel[metric]} compared across ${yearOverYear.map((year) => year.year).join(', ')}. February 29 appears only in leap years.`}
          height={340}
        />
      ) : null}
    </div>
  );
}

function Total({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <article className="rounded-2xl border border-white/10 bg-panel p-5">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      {hint ? <p className="mt-2 text-xs text-muted">{hint}</p> : null}
    </article>
  );
}
