import Link from 'next/link';
import { entityListSchema } from '@/lib/api/entities';
import { decodeOffsetCursor, encodeOffsetCursor } from '@/lib/api/pagination';
import { requireSession } from '@/lib/auth/request-session';
import { database } from '@/lib/db/client';
import { ApiRepository } from '@/lib/db/repositories/api';
import { normalizedRange } from '@/lib/api/ranges';
import { rankedEntities } from '@/lib/stats/queries';
import { DebouncedSearchInput } from '@/components/filters/DebouncedSearchInput';

type Kind = 'track' | 'artist' | 'album';
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const labels = {
  track: { title: 'Tracks', singular: 'track', path: '/tracks' },
  artist: { title: 'Artists', singular: 'artist', path: '/artists' },
  album: { title: 'Albums', singular: 'album', path: '/albums' },
} as const;

function humanDuration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}m`;
}

export async function EntityIndexPage({
  kind,
  searchParams,
}: {
  kind: Kind;
  searchParams: SearchParams;
}) {
  const session = await requireSession();
  const raw = await searchParams;
  const parsed = entityListSchema.parse(
    Object.fromEntries(
      Object.entries(raw).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    ),
  );
  const settings = await new ApiRepository(database).settings(session.userId);
  const range = normalizedRange(
    {
      range: parsed.range,
      ...(parsed.from ? { from: parsed.from } : {}),
      ...(parsed.to ? { to: parsed.to } : {}),
      ...(parsed.tz ? { tz: parsed.tz } : {}),
    },
    settings,
  );
  const offset = decodeOffsetCursor(parsed.cursor);
  // Ranking and pagination happen in the query; nothing beyond this page is
  // ever loaded.
  const { items, hasMore } = await rankedEntities(
    database,
    session.userId,
    range,
    kind,
    parsed.q,
    parsed.sort,
    { limit: parsed.limit, offset },
  );
  const nextCursor = hasMore ? encodeOffsetCursor(offset + parsed.limit) : null;
  const definition = labels[kind];
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries(raw))
    if (typeof value === 'string' && key !== 'cursor')
      nextParams.set(key, value);
  if (nextCursor) nextParams.set('cursor', nextCursor);

  return (
    <div className="space-y-7">
      <header>
        <p className="text-sm text-accent">Library</p>
        <h1 className="mt-1 text-4xl font-semibold">{definition.title}</h1>
        {kind === 'artist' ? (
          <p className="mt-3 max-w-2xl text-sm text-muted">
            Artist play credits overlap on collaborations and must not be added
            together as total plays.
          </p>
        ) : null}
      </header>
      <form className="grid gap-3 rounded-2xl border border-white/10 bg-panel p-4 sm:grid-cols-2 xl:grid-cols-[1fr_auto_auto_auto]">
        <label className="grid gap-1 text-sm">
          Search {definition.title.toLocaleLowerCase()}
          <DebouncedSearchInput
            defaultValue={parsed.q ?? ''}
            key={parsed.q ?? ''}
            label={`Search ${definition.title.toLocaleLowerCase()}`}
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
          Sort
          <select
            className="rounded-lg border border-white/15 bg-background px-3 py-2"
            defaultValue={parsed.sort}
            name="sort"
          >
            <option value="plays">Plays</option>
            <option value="estimatedDuration">Estimated listening time</option>
            <option value="name">Name</option>
          </select>
        </label>
        {parsed.from ? (
          <input name="from" type="hidden" value={parsed.from} />
        ) : null}
        {parsed.to ? <input name="to" type="hidden" value={parsed.to} /> : null}
        {parsed.tz ? <input name="tz" type="hidden" value={parsed.tz} /> : null}
        <button
          className="self-end rounded-lg border border-accent/50 px-4 py-2 text-sm text-accent"
          type="submit"
        >
          Apply
        </button>
      </form>
      <p className="text-sm text-muted">
        {range.preset.replaceAll('_', ' ').toLocaleLowerCase()} ·{' '}
        {range.timezone}
      </p>
      {items.length ? (
        <ol className="divide-y divide-white/10 rounded-2xl border border-white/10 bg-panel/80">
          {items.map((item, index) => (
            <li
              className="grid gap-2 p-4 sm:grid-cols-[3rem_1fr_auto] sm:items-center"
              key={item.id}
            >
              <span className="text-sm text-muted">#{offset + index + 1}</span>
              <Link
                className="min-w-0 font-medium hover:text-accent"
                href={`${definition.path}/${item.id}`}
              >
                {item.name}
              </Link>
              <span className="text-sm text-muted sm:text-right">
                {item.plays.toLocaleString()} plays ·{' '}
                {humanDuration(item.estimatedDurationMs)} estimated
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="rounded-2xl border border-dashed border-white/20 p-10 text-center">
          No {definition.title.toLocaleLowerCase()} match these filters.
        </div>
      )}
      {nextCursor ? (
        <Link
          className="inline-flex rounded-lg border border-white/15 px-4 py-2 text-sm hover:border-accent/60"
          href={`${definition.path}?${nextParams.toString()}`}
        >
          Next page
        </Link>
      ) : null}
    </div>
  );
}
