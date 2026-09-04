import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { RangeFilter } from '@/components/filters/RangeFilter';
import { TrendChart } from '@/components/charts/TrendChart';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { requireSession } from '@/lib/auth/request-session';
import { database } from '@/lib/db/client';
import { ApiRepository } from '@/lib/db/repositories/api';
import { resolveRange, type RangePreset } from '@/lib/stats/dates';
import { entityDetailData } from '@/lib/stats/entity-details';

type Kind = 'track' | 'artist' | 'album';
const paths = {
  track: '/tracks',
  artist: '/artists',
  album: '/albums',
} as const;
const titles = { track: 'Tracks', artist: 'Artists', album: 'Albums' } as const;
const ranges = new Set<RangePreset>([
  'TODAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
  'CURRENT_MONTH',
  'CURRENT_YEAR',
  'ALL_TIME',
]);

function duration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}m`;
}

export async function EntityDetailPage({
  kind,
  id,
  searchParams,
}: {
  kind: Kind;
  id: string;
  searchParams: Promise<{ range?: string }>;
}) {
  if (!z.uuid().safeParse(id).success) notFound();
  const session = await requireSession();
  const settings = await new ApiRepository(database).settings(session.userId);
  const requested = (await searchParams).range;
  const preset =
    requested && ranges.has(requested as RangePreset)
      ? (requested as RangePreset)
      : (settings.defaultRange as RangePreset);
  const range = resolveRange({
    preset,
    timezone: settings.timezone,
    weekStartsOn: settings.weekStartsOn,
    now: new Date(),
  });
  const detail = await entityDetailData(
    database,
    session.userId,
    range,
    settings.weekStartsOn,
    kind,
    id,
  );
  if (!detail) notFound();
  const entity = detail.entity;

  return (
    <div className="space-y-7">
      <Breadcrumbs
        current={entity.name}
        parent={titles[kind]}
        parentHref={paths[kind]}
      />
      <header className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
        <div className="min-w-0">
          <p className="text-sm capitalize text-accent">{kind}</p>
          <h1 className="mt-1 break-words text-4xl font-semibold">
            {entity.name}
          </h1>
          {(kind === 'track' || kind === 'album') && 'artists' in entity ? (
            <p className="mt-2 flex flex-wrap gap-x-2 text-muted">
              {entity.artists.length
                ? entity.artists.map(({ artist }, index) => (
                    <span key={artist.id}>
                      <Link
                        className="hover:text-accent"
                        href={`/artists/${artist.id}`}
                      >
                        {artist.name}
                      </Link>
                      {index < entity.artists.length - 1 ? ',' : ''}
                    </span>
                  ))
                : 'Unknown artist'}
            </p>
          ) : null}
        </div>
        <RangeFilter value={preset} timezone={settings.timezone} />
      </header>
      <section
        aria-label={`${entity.name} summary`}
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <KpiCard label="Plays" value={detail.totals.plays.toLocaleString()} />
        <KpiCard
          hint="Spotify provides no actual played milliseconds. This estimate sums each track's full duration."
          label="Estimated listening time"
          value={duration(detail.totals.estimatedDurationMs)}
        />
        <KpiCard
          label="First recorded play"
          value={detail.firstPlayedAt?.toLocaleDateString() ?? '—'}
        />
        <KpiCard
          label="Last recorded play"
          value={detail.lastPlayedAt?.toLocaleDateString() ?? '—'}
        />
      </section>
      {kind === 'artist' && detail.rank ? (
        <p className="rounded-xl border border-accent/30 bg-accent/10 p-4">
          Rank #{detail.rank} by artist play credits in this range.
          Collaborations overlap.
        </p>
      ) : null}
      {kind === 'track' && 'album' in entity && entity.album ? (
        <p className="text-sm text-muted">
          Album:{' '}
          <Link
            className="text-white hover:text-accent"
            href={`/albums/${entity.album.id}`}
          >
            {entity.album.name}
          </Link>
        </p>
      ) : null}
      <TrendChart points={detail.trend} />
      {(kind === 'artist' || kind === 'album') && detail.topTracks.length ? (
        <RankedLinks
          heading={kind === 'album' ? 'Track breakdown' : 'Top tracks'}
          items={detail.topTracks}
          path="/tracks"
        />
      ) : null}
      {kind === 'artist' && detail.topAlbums.length ? (
        <RankedLinks
          heading="Top albums"
          items={detail.topAlbums}
          path="/albums"
        />
      ) : null}
      <section className="rounded-2xl border border-white/10 bg-panel/80 p-5">
        <h2 className="text-lg font-semibold">Recent plays</h2>
        {detail.recentPlays.length ? (
          <ol className="mt-3 divide-y divide-white/10">
            {detail.recentPlays.map((play) => (
              <li
                className="flex flex-wrap justify-between gap-2 py-3"
                key={play.id}
              >
                <Link
                  className="hover:text-accent"
                  href={`/tracks/${play.track.id}`}
                >
                  {play.track.name}
                </Link>
                <time
                  className="text-sm text-muted"
                  dateTime={play.playedAt.toISOString()}
                >
                  {play.playedAt.toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 text-sm text-muted">No plays in this range.</p>
        )}
      </section>
    </div>
  );
}

function RankedLinks({
  heading,
  items,
  path,
}: {
  heading: string;
  items: Array<{
    id: string;
    name: string;
    plays: number;
    estimatedDurationMs: number;
  }>;
  path: string;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-panel/80 p-5">
      <h2 className="text-lg font-semibold">{heading}</h2>
      <ol className="mt-3 divide-y divide-white/10">
        {items.map((item) => (
          <li
            className="flex flex-wrap justify-between gap-2 py-3"
            key={item.id}
          >
            <Link className="hover:text-accent" href={`${path}/${item.id}`}>
              {item.name}
            </Link>
            <span className="text-sm text-muted">
              {item.plays} plays · {duration(item.estimatedDurationMs)}{' '}
              estimated
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
