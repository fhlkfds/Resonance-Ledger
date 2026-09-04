import { Prisma } from '@prisma/client';
import type { ResolvedRange } from './dates';

export type EntityKind = 'track' | 'artist' | 'album';
export type EntityScope = { kind: EntityKind; id: string };

export type RankedEntity = {
  id: string;
  name: string;
  normalizedName: string;
  plays: number;
  estimatedDurationMs: number;
};

/**
 * The one ranking order used everywhere: plays desc, then estimated duration
 * desc, then normalized name, then id. Three byte-identical copies of this
 * previously lived in queries.ts, analytics.ts, and entity-details.ts.
 */
export const rankOrder = (left: RankedEntity, right: RankedEntity) =>
  right.plays - left.plays ||
  right.estimatedDurationMs - left.estimatedDurationMs ||
  left.normalizedName.localeCompare(right.normalizedName) ||
  left.id.localeCompare(right.id);

/**
 * The one tenant-scoped event filter. Three separate copies of this used to
 * exist, which meant tenant scoping could be fixed in two of three places.
 */
export function eventWhere(
  userId: string,
  range: ResolvedRange,
  entity?: EntityScope,
): Prisma.ListeningHistoryWhereInput {
  return {
    spotifyAccount: { userId },
    playedAt: { ...(range.from ? { gte: range.from } : {}), lt: range.to },
    ...(entity?.kind === 'track' ? { trackId: entity.id } : {}),
    ...(entity?.kind === 'album' ? { track: { albumId: entity.id } } : {}),
    ...(entity?.kind === 'artist'
      ? { track: { artists: { some: { artistId: entity.id } } } }
      : {}),
  };
}

/**
 * The same filter as a SQL fragment: a `scoped` CTE exposing exactly the
 * event columns the aggregates need. Every value is a bound parameter --
 * nothing is interpolated -- and the join to spotify_accounts is what
 * enforces tenancy, so this must be the only way ./aggregate.ts reaches the
 * events table.
 *
 * PostgreSQL inlines a non-recursive CTE referenced once, so this does not
 * force materialisation of the scope.
 */
export function scopedEventsCte(
  userId: string,
  range: ResolvedRange,
  entity?: EntityScope,
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`sa.user_id = ${userId}::uuid`,
    Prisma.sql`h.played_at < ${range.to}`,
  ];
  if (range.from) conditions.push(Prisma.sql`h.played_at >= ${range.from}`);
  if (entity?.kind === 'track')
    conditions.push(Prisma.sql`h.track_id = ${entity.id}::uuid`);
  if (entity?.kind === 'album')
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM tracks scope_t WHERE scope_t.id = h.track_id AND scope_t.album_id = ${entity.id}::uuid)`,
    );
  if (entity?.kind === 'artist')
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM track_artists scope_ta WHERE scope_ta.track_id = h.track_id AND scope_ta.artist_id = ${entity.id}::uuid)`,
    );
  return Prisma.sql`
    scoped AS (
      SELECT h.id, h.track_id, h.played_at, h.estimated_duration_ms
      FROM listening_history h
      JOIN spotify_accounts sa ON sa.id = h.spotify_account_id
      WHERE ${Prisma.join(conditions, ' AND ')}
    )`;
}
