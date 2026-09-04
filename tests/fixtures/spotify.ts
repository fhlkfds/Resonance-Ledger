import type { SpotifyPlayedItem } from '@/lib/spotify/schemas';

export function spotifyItem(
  overrides: Partial<SpotifyPlayedItem> = {},
): SpotifyPlayedItem {
  return {
    played_at: '2026-09-03T12:00:00.000Z',
    track: {
      id: 'track-1',
      name: 'Track One',
      duration_ms: 180_000,
      disc_number: 1,
      track_number: 1,
      explicit: false,
      is_local: false,
      uri: 'spotify:track:track-1',
      external_ids: { isrc: 'ISRC1' },
      artists: [
        { id: 'artist-1', name: 'Artist One', uri: 'spotify:artist:artist-1' },
        { id: 'artist-2', name: 'Artist Two', uri: 'spotify:artist:artist-2' },
      ],
      album: {
        id: 'album-1',
        name: 'Album One',
        album_type: 'album',
        release_date: '2026-09',
        release_date_precision: 'month',
        uri: 'spotify:album:album-1',
        images: [],
        artists: [
          {
            id: 'artist-1',
            name: 'Artist One',
            uri: 'spotify:artist:artist-1',
          },
        ],
      },
    },
    ...overrides,
  };
}

export function recentlyPlayedPage(
  items: SpotifyPlayedItem[],
  next: string | null = null,
): object {
  return { items, next, cursors: { after: 'fixture' } };
}
