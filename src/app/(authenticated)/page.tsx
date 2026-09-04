import { KpiCard } from '@/components/dashboard/KpiCard';
import { RangeFilter } from '@/components/filters/RangeFilter';
import { TrendChart } from '@/components/charts/TrendChart';
import { requireSession } from '@/lib/auth/request-session';
import { database } from '@/lib/db/client';
import { resolveRange, type RangePreset } from '@/lib/stats/dates';
import { dashboardData } from '@/lib/stats/queries';
import { ESTIMATE_CAVEAT, formatDuration } from '@/lib/format';

const validRanges = new Set<RangePreset>([
  'TODAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
  'CURRENT_MONTH',
  'CURRENT_YEAR',
  'ALL_TIME',
]);

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const session = await requireSession();
  const settings = await database.userSettings.findUniqueOrThrow({
    where: { userId: session.userId },
  });
  const requested = (await searchParams).range;
  const preset =
    requested && validRanges.has(requested as RangePreset)
      ? (requested as RangePreset)
      : (settings.defaultRange as RangePreset);
  const range = resolveRange({
    preset,
    timezone: settings.timezone,
    weekStartsOn: settings.weekStartsOn,
    now: new Date(),
  });
  const [data, account] = await Promise.all([
    dashboardData(
      database,
      session.userId,
      range,
      undefined,
      settings.weekStartsOn,
    ),
    database.spotifyAccount.findFirst({
      where: { userId: session.userId },
      include: { syncState: true },
    }),
  ]);
  const recent = await database.listeningHistory.findMany({
    where: { spotifyAccount: { userId: session.userId } },
    orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
    take: 10,
    include: {
      track: {
        include: {
          artists: { orderBy: { position: 'asc' }, include: { artist: true } },
        },
      },
    },
  });
  return (
    <div className="space-y-8">
      <header className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
        <div>
          <p className="text-sm text-accent">Dashboard</p>
          <h1 className="mt-1 text-4xl font-semibold tracking-tight">
            Listening ledger
          </h1>
        </div>
        <RangeFilter value={preset} timezone={settings.timezone} />
      </header>
      {account?.state === 'NEEDS_REAUTH' ? (
        <aside
          className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4"
          role="alert"
        >
          Spotify authorization has expired. Open Settings to reauthorize.
        </aside>
      ) : null}
      {account?.syncState?.probableGap ? (
        <aside
          className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4"
          role="status"
        >
          Synchronization is healthy, but a probable gap exists in historical
          coverage.
        </aside>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span
          className={`h-2 w-2 rounded-full ${account?.syncState?.status === 'BACKOFF' ? 'bg-amber-400' : 'bg-accent'}`}
        />
        <span>
          Sync{' '}
          {account?.syncState?.status.toLocaleLowerCase() ?? 'not connected'}
          {account?.syncState?.lastSuccessAt
            ? ` · last success ${account.syncState.lastSuccessAt.toLocaleString()}`
            : ''}
        </span>
      </div>
      <section
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
        aria-label="Listening summary"
      >
        <KpiCard
          label="Estimated listening time"
          value={formatDuration(data.totals.estimatedDurationMs)}
          hint={ESTIMATE_CAVEAT}
        />
        <KpiCard
          label="Total plays"
          value={data.totals.plays.toLocaleString()}
        />
        <KpiCard
          label="Unique artists"
          value={data.totals.uniqueArtists.toLocaleString()}
        />
        <KpiCard
          label="Unique albums"
          value={data.totals.uniqueAlbums.toLocaleString()}
        />
        <KpiCard
          label="Unique tracks"
          value={data.totals.uniqueTracks.toLocaleString()}
        />
      </section>
      {data.totals.plays === 0 ? (
        <section className="rounded-3xl border border-dashed border-white/20 p-10 text-center">
          <h2 className="text-xl font-semibold">No plays in this range</h2>
          <p className="mt-2 text-muted">
            Connect Spotify or wait for the next synchronization, then try
            another date range.
          </p>
        </section>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-3">
            <article className="rounded-2xl border border-white/10 bg-panel p-5">
              <p className="text-sm text-muted">Top artist</p>
              <h2 className="mt-3 text-xl font-semibold">
                {data.topArtist?.name}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {data.topArtist?.plays} play credits · collaborations overlap
              </p>
            </article>
            <article className="rounded-2xl border border-white/10 bg-panel p-5">
              <p className="text-sm text-muted">Top track</p>
              <h2 className="mt-3 text-xl font-semibold">
                {data.topTrack?.name}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {data.topTrack?.plays} plays
              </p>
            </article>
            <article className="rounded-2xl border border-white/10 bg-panel p-5">
              <p className="text-sm text-muted">Most active listening day</p>
              <h2 className="mt-3 text-xl font-semibold">
                {data.mostActiveDay?.date}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {data.mostActiveDay?.plays} plays ·{' '}
                {formatDuration(data.mostActiveDay?.estimatedDurationMs ?? 0)}{' '}
                estimated
              </p>
            </article>
          </section>
          <TrendChart points={data.trend} />
        </>
      )}
      <section className="rounded-2xl border border-white/10 bg-panel/80 p-5">
        <h2 className="text-lg font-semibold">Recent plays</h2>
        {recent.length ? (
          <ol className="mt-4 divide-y divide-white/10">
            {recent.map((event) => (
              <li
                key={event.id}
                className="flex items-center justify-between gap-4 py-3"
              >
                <div>
                  <p>{event.track.name}</p>
                  <p className="text-sm text-muted">
                    {event.track.artists
                      .map(({ artist }) => artist.name)
                      .join(', ')}
                  </p>
                </div>
                <time
                  className="shrink-0 text-xs text-muted"
                  dateTime={event.playedAt.toISOString()}
                >
                  {event.playedAt.toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 text-sm text-muted">No retained plays yet.</p>
        )}
      </section>
    </div>
  );
}
