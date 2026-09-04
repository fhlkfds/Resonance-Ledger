import Link from 'next/link';
import { decodeCursor, encodeCursor } from '@/lib/api/pagination';
import { historyQuerySchema } from '@/lib/api/history-query';
import { normalizedRange } from '@/lib/api/ranges';
import { assertOwnedEntityFilters } from '@/lib/api/ownership';
import { requireSession } from '@/lib/auth/request-session';
import { database } from '@/lib/db/client';
import { ApiRepository } from '@/lib/db/repositories/api';
import { DebouncedSearchInput } from '@/components/filters/DebouncedSearchInput';

export default async function HistoryPage(props: PageProps<'/history'>) {
  const session = await requireSession();
  const raw = await props.searchParams;
  const parsed = historyQuerySchema.parse(
    Object.fromEntries(
      Object.entries(raw).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    ),
  );
  const repository = new ApiRepository(database);
  await assertOwnedEntityFilters(repository, session.userId, parsed);
  const settings = await repository.settings(session.userId);
  const range = normalizedRange(
    {
      range: parsed.range,
      ...(parsed.from ? { from: parsed.from } : {}),
      ...(parsed.to ? { to: parsed.to } : {}),
      ...(parsed.tz ? { tz: parsed.tz } : {}),
    },
    settings,
  );
  const rows = await repository.history(session.userId, {
    range,
    limit: parsed.limit,
    cursor: decodeCursor(parsed.cursor ?? null),
    ...(parsed.q ? { q: parsed.q } : {}),
    ...(parsed.artistId ? { artistId: parsed.artistId } : {}),
    ...(parsed.albumId ? { albumId: parsed.albumId } : {}),
    ...(parsed.trackId ? { trackId: parsed.trackId } : {}),
    ...(parsed.explicit === undefined ? {} : { explicit: parsed.explicit }),
  });
  const hasMore = rows.length > parsed.limit;
  const events = rows.slice(0, parsed.limit);
  const last = events.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({ at: last.playedAt.toISOString(), id: last.id })
      : null;
  const retained = new URLSearchParams();
  for (const [key, value] of Object.entries(raw))
    if (typeof value === 'string' && key !== 'cursor') retained.set(key, value);
  const exportParams = new URLSearchParams(retained);
  exportParams.set('type', 'history');
  exportParams.set('format', 'csv');
  if (nextCursor) retained.set('cursor', nextCursor);

  return (
    <div className="space-y-7">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-accent">Listening ledger</p>
          <h1 className="mt-1 text-4xl font-semibold">History</h1>
        </div>
        <a
          className="w-fit rounded-lg border border-white/15 px-4 py-2 text-sm hover:border-accent/60"
          href={`/api/export?${exportParams.toString()}`}
        >
          Export filtered CSV
        </a>
      </header>
      <form className="grid gap-3 rounded-2xl border border-white/10 bg-panel p-4 md:grid-cols-4">
        <label className="grid gap-1 text-sm md:col-span-2">
          Search track
          <DebouncedSearchInput
            defaultValue={parsed.q ?? ''}
            key={parsed.q ?? ''}
            label="Search track"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Date range
          <select
            className="rounded-lg border border-white/15 bg-background px-3 py-2"
            defaultValue={parsed.range}
            name="range"
          >
            <option value="TODAY">Today</option>
            <option value="LAST_7_DAYS">Last 7 days</option>
            <option value="LAST_30_DAYS">Last 30 days</option>
            <option value="CURRENT_MONTH">Current month</option>
            <option value="CURRENT_YEAR">Current year</option>
            <option value="ALL_TIME">All retained history</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Explicit
          <select
            className="rounded-lg border border-white/15 bg-background px-3 py-2"
            defaultValue={raw.explicit ?? ''}
            name="explicit"
          >
            <option value="">All</option>
            <option value="true">Explicit only</option>
            <option value="false">Not explicit</option>
          </select>
        </label>
        {(['artistId', 'albumId', 'trackId'] as const).map((name) =>
          parsed[name] ? (
            <input key={name} name={name} type="hidden" value={parsed[name]} />
          ) : null,
        )}
        <button
          className="w-fit rounded-lg border border-accent/50 px-4 py-2 text-sm text-accent"
          type="submit"
        >
          Apply filters
        </button>
      </form>
      <p className="text-sm text-muted">
        {range.preset.replaceAll('_', ' ').toLocaleLowerCase()} ·{' '}
        {range.timezone} · newest first
      </p>
      {events.length ? (
        <ol className="divide-y divide-white/10 rounded-2xl border border-white/10 bg-panel/80">
          {events.map((event) => (
            <li
              className="grid gap-2 p-4 md:grid-cols-[1fr_1fr_auto] md:items-center"
              key={event.id}
            >
              <div className="min-w-0">
                <Link
                  className="font-medium hover:text-accent"
                  href={`/tracks/${event.track.id}`}
                >
                  {event.track.name}
                </Link>
                <p className="mt-1 text-sm text-muted">
                  {event.track.artists
                    .map(({ artist }) => artist.name)
                    .join(', ') || 'Unknown artist'}
                </p>
              </div>
              <div className="text-sm text-muted">
                {event.track.album ? (
                  <Link
                    className="hover:text-white"
                    href={`/albums/${event.track.album.id}`}
                  >
                    {event.track.album.name}
                  </Link>
                ) : (
                  'No album'
                )}
              </div>
              <time
                className="text-sm text-muted md:text-right"
                dateTime={event.playedAt.toISOString()}
              >
                {event.playedAt.toLocaleString('en-US', {
                  timeZone: range.timezone,
                })}
              </time>
            </li>
          ))}
        </ol>
      ) : (
        <div className="rounded-2xl border border-dashed border-white/20 p-10 text-center">
          No recorded plays match these filters.
        </div>
      )}
      {nextCursor ? (
        <Link
          className="inline-flex rounded-lg border border-white/15 px-4 py-2 text-sm hover:border-accent/60"
          href={`/history?${retained.toString()}`}
        >
          Next page
        </Link>
      ) : null}
    </div>
  );
}
