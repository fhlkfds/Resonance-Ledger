import { describe, expect, it } from 'vitest';
import { normalizeName, normalizePlayedItem } from '@/lib/spotify/normalize';
import { spotifyItem } from '../fixtures/spotify';

/**
 * T-007 edge cases: a played item is untrusted input, so every optional field
 * Spotify may omit has to normalize to a stable shape rather than throw.
 */

describe('T-007 name normalization', () => {
  it('folds case, width, and whitespace to one search key', () => {
    expect(normalizeName('  The   Weeknd  ')).toBe(normalizeName('the weeknd'));
    // NFKC folds full-width characters onto their ASCII equivalents.
    expect(normalizeName('ＢＬＡＣＫＰＩＮＫ')).toBe(
      normalizeName('blackpink'),
    );
  });

  it('keeps distinct names distinct', () => {
    expect(normalizeName('Alpha')).not.toBe(normalizeName('Alpha II'));
  });
});

describe('T-007 missing and partial fields', () => {
  it('normalizes a track with no album', () => {
    const play = normalizePlayedItem(
      spotifyItem({
        track: { ...spotifyItem().track, album: null },
      } as never),
    );
    expect(play.track.album).toBeNull();
    expect(play.track.externalKey).toBe('spotify:track-1');
  });

  it('keeps a partial release date at its stated precision', () => {
    const play = normalizePlayedItem(spotifyItem());
    // The fixture is month precision: no day is invented.
    expect(play.track.album?.releaseDateText).toBe('2026-09');
    expect(play.track.album?.releaseDatePrecision).toBe('month');
    expect(play.track.album?.releaseYear).toBe(2026);
  });

  it('carries a year-precision release date without a month', () => {
    const base = spotifyItem();
    const play = normalizePlayedItem(
      spotifyItem({
        track: {
          ...base.track,
          album: {
            ...base.track.album!,
            release_date: '1994',
            release_date_precision: 'year',
          },
        },
      } as never),
    );
    expect(play.track.album?.releaseDateText).toBe('1994');
    expect(play.track.album?.releaseYear).toBe(1994);
  });

  it('leaves the release year null when Spotify omits the date', () => {
    const base = spotifyItem();
    const album = { ...base.track.album! } as Record<string, unknown>;
    delete album.release_date;
    delete album.release_date_precision;
    const play = normalizePlayedItem(
      spotifyItem({ track: { ...base.track, album } } as never),
    );
    expect(play.track.album?.releaseDateText).toBeNull();
    expect(play.track.album?.releaseDatePrecision).toBeNull();
    expect(play.track.album?.releaseYear).toBeNull();
  });

  it('leaves artwork null when the album has no images', () => {
    expect(
      normalizePlayedItem(spotifyItem()).track.album?.artworkUrl,
    ).toBeNull();
  });

  it('takes the first image when artwork is present', () => {
    const base = spotifyItem();
    const play = normalizePlayedItem(
      spotifyItem({
        track: {
          ...base.track,
          album: {
            ...base.track.album!,
            images: [
              { url: 'https://i.scdn.co/image/large' },
              { url: 'https://i.scdn.co/image/small' },
            ],
          },
        },
      } as never),
    );
    expect(play.track.album?.artworkUrl).toBe('https://i.scdn.co/image/large');
  });

  it('normalizes a track with no ISRC or optional numbers', () => {
    const base = spotifyItem();
    const track = { ...base.track } as Record<string, unknown>;
    delete track.external_ids;
    delete track.disc_number;
    delete track.track_number;
    delete track.uri;
    const play = normalizePlayedItem(spotifyItem({ track } as never));
    expect(play.track.isrc).toBeNull();
    expect(play.track.discNumber).toBeNull();
    expect(play.track.trackNumber).toBeNull();
    expect(play.track.spotifyUri).toBeNull();
  });
});

describe('T-007 local tracks', () => {
  it('marks a track local when Spotify supplies no id', () => {
    const base = spotifyItem();
    const play = normalizePlayedItem(
      spotifyItem({
        track: { ...base.track, id: null, is_local: true },
      } as never),
    );
    expect(play.track.isLocal).toBe(true);
    expect(play.track.spotifyId).toBeNull();
    expect(play.track.externalKey).toMatch(/^local:[0-9a-f]{64}$/);
  });

  it('treats a missing id as local even when the flag says otherwise', () => {
    const base = spotifyItem();
    const play = normalizePlayedItem(
      spotifyItem({
        track: { ...base.track, id: null, is_local: false },
      } as never),
    );
    expect(play.track.isLocal).toBe(true);
  });

  it('gives an artist without an id a deterministic local key', () => {
    const base = spotifyItem();
    const build = () =>
      normalizePlayedItem(
        spotifyItem({
          track: {
            ...base.track,
            artists: [{ id: null, name: 'Unsigned Act' }],
          },
        } as never),
      );
    const first = build();
    const second = build();
    expect(first.track.artists[0]!.externalKey).toMatch(/^local:[0-9a-f]{64}$/);
    expect(first.track.artists[0]!.externalKey).toBe(
      second.track.artists[0]!.externalKey,
    );
  });

  it('separates two local tracks that differ only by duration', () => {
    const base = spotifyItem();
    const keyFor = (durationMs: number) =>
      normalizePlayedItem(
        spotifyItem({
          track: { ...base.track, id: null, duration_ms: durationMs },
        } as never),
      ).track.externalKey;
    expect(keyFor(180_000)).not.toBe(keyFor(180_001));
  });
});

describe('T-007 artist credit order', () => {
  it('preserves the order Spotify lists', () => {
    const play = normalizePlayedItem(spotifyItem());
    expect(play.track.artists.map((artist) => artist.name)).toEqual([
      'Artist One',
      'Artist Two',
    ]);
  });

  it('captures the full duration as the estimate, unchanged', () => {
    const play = normalizePlayedItem(spotifyItem());
    // The estimate is the track's full length; no playback progress is inferred.
    expect(play.estimatedDurationMs).toBe(180_000);
    expect(play.estimatedDurationMs).toBe(play.track.durationMs);
  });
});
