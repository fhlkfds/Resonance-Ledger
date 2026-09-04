import { ProblemError } from './errors';
import { ApiRepository } from '@/lib/db/repositories/api';

export async function assertOwnedEntityFilters(
  repository: ApiRepository,
  userId: string,
  filters: {
    trackId?: string | undefined;
    artistId?: string | undefined;
    albumId?: string | undefined;
  },
): Promise<void> {
  const checks = [
    filters.trackId
      ? repository.entityForUser(userId, 'track', filters.trackId)
      : true,
    filters.artistId
      ? repository.entityForUser(userId, 'artist', filters.artistId)
      : true,
    filters.albumId
      ? repository.entityForUser(userId, 'album', filters.albumId)
      : true,
  ];
  const values = await Promise.all(checks);
  if (values.some((value) => value === null)) {
    throw new ProblemError(404, 'ENTITY_NOT_FOUND', 'Entity not found');
  }
}
