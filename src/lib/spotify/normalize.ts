import { createHash } from 'node:crypto';
import type { SpotifyPlayedItem } from './schemas';

export function normalizeName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function localKey(
  parts: readonly (string | number | null | undefined)[],
): string {
  const canonical = parts
    .map((part) =>
      typeof part === 'string' ? normalizeName(part) : String(part ?? ''),
    )
    .join('|');
  return `local:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function externalKey(
  spotifyId: string | null,
  localParts: readonly (string | number | null | undefined)[],
): string {
  return spotifyId ? `spotify:${spotifyId}` : localKey(localParts);
}

export type NormalizedArtist = {
  externalKey: string;
  spotifyId: string | null;
  name: string;
  normalizedName: string;
  spotifyUri: string | null;
  imageUrl: string | null;
};

export type NormalizedAlbum = {
  externalKey: string;
  spotifyId: string | null;
  name: string;
  normalizedName: string;
  albumType: string | null;
  releaseDateText: string | null;
  releaseDatePrecision: string | null;
  releaseYear: number | null;
  spotifyUri: string | null;
  artworkUrl: string | null;
  artists: NormalizedArtist[];
};

export type NormalizedPlay = {
  playedAt: Date;
  estimatedDurationMs: number;
  track: {
    externalKey: string;
    spotifyId: string | null;
    name: string;
    normalizedName: string;
    durationMs: number;
    discNumber: number | null;
    trackNumber: number | null;
    explicit: boolean;
    isLocal: boolean;
    spotifyUri: string | null;
    isrc: string | null;
    artists: NormalizedArtist[];
    album: NormalizedAlbum | null;
  };
};

function normalizeArtist(
  artist: SpotifyPlayedItem['track']['artists'][number],
): NormalizedArtist {
  return {
    externalKey: externalKey(artist.id, ['artist', artist.name]),
    spotifyId: artist.id,
    name: artist.name,
    normalizedName: normalizeName(artist.name),
    spotifyUri: artist.uri ?? null,
    imageUrl: null,
  };
}

export function normalizePlayedItem(item: SpotifyPlayedItem): NormalizedPlay {
  const artists = item.track.artists.map(normalizeArtist);
  const album = item.track.album
    ? {
        externalKey: externalKey(item.track.album.id, [
          'album',
          item.track.album.name,
          ...item.track.album.artists.map((artist) => artist.name),
        ]),
        spotifyId: item.track.album.id,
        name: item.track.album.name,
        normalizedName: normalizeName(item.track.album.name),
        albumType: item.track.album.album_type ?? null,
        releaseDateText: item.track.album.release_date ?? null,
        releaseDatePrecision: item.track.album.release_date_precision ?? null,
        releaseYear: item.track.album.release_date
          ? Number(item.track.album.release_date.slice(0, 4))
          : null,
        spotifyUri: item.track.album.uri ?? null,
        artworkUrl: item.track.album.images[0]?.url ?? null,
        artists: item.track.album.artists.map(normalizeArtist),
      }
    : null;
  const albumName = item.track.album?.name ?? '';
  return {
    playedAt: new Date(item.played_at),
    estimatedDurationMs: item.track.duration_ms,
    track: {
      externalKey: externalKey(item.track.id, [
        item.track.name,
        albumName,
        ...item.track.artists.map((artist) => artist.name),
        item.track.duration_ms,
      ]),
      spotifyId: item.track.id,
      name: item.track.name,
      normalizedName: normalizeName(item.track.name),
      durationMs: item.track.duration_ms,
      discNumber: item.track.disc_number ?? null,
      trackNumber: item.track.track_number ?? null,
      explicit: item.track.explicit,
      isLocal: item.track.is_local || item.track.id === null,
      spotifyUri: item.track.uri ?? null,
      isrc: item.track.external_ids?.isrc ?? null,
      artists,
      album,
    },
  };
}
