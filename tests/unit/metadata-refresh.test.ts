import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '@/lib/env';
import { refreshMetadata } from '@/worker/metadata-refresh';
import { spotifyItem } from '../fixtures/spotify';

describe('metadata refresh', () => {
  it('refreshes a bounded recently played batch with fixture responses', async () => {
    const track = {
      ...spotifyItem().track,
      name: 'Fresh Track',
      album: {
        ...spotifyItem().track.album!,
        images: [{ url: 'https://img.test/album' }],
      },
    };
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return Response.json(
        url.pathname === '/v1/tracks'
          ? { tracks: [track] }
          : {
              artists: track.artists.map((artist) => ({
                ...artist,
                images: [{ url: `https://img.test/${artist.id}` }],
              })),
            },
      );
    }) as unknown as typeof fetch;
    const upsertTrack = vi.fn().mockResolvedValue({ id: 'track-row' });
    const upsertAlbum = vi.fn().mockResolvedValue({ id: 'album-row' });
    const upsertArtist = vi.fn().mockResolvedValue({ id: 'artist-row' });
    const transaction = {
      track: { upsert: upsertTrack },
      album: { upsert: upsertAlbum },
      artist: { upsert: upsertArtist },
      trackArtist: {
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
      albumArtist: {
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
    };
    const database = {
      spotifyAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: 'account-id' }),
      },
      listeningHistory: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { track: { spotifyId: 'track-1' } },
            { track: { spotifyId: 'track-1' } },
          ]),
      },
      $transaction: vi.fn(
        (callback: (client: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    } as unknown as PrismaClient;

    await expect(
      refreshMetadata(
        database,
        {} as Environment,
        new Date('2026-09-04T12:00:00Z'),
        {
          fetcher,
          token: vi.fn().mockResolvedValue('fixture-token'),
        },
      ),
    ).resolves.toBe(1);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(upsertTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ name: 'Fresh Track' }),
      }),
    );
    expect(upsertAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          artworkUrl: 'https://img.test/album',
        }),
      }),
    );
    expect(upsertArtist).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          imageUrl: 'https://img.test/artist-1',
        }),
      }),
    );
  });

  it('does not call Spotify when no stale recent entity exists', async () => {
    const fetcher = vi.fn();
    const database = {
      spotifyAccount: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    await expect(
      refreshMetadata(database, {} as Environment, new Date(), { fetcher }),
    ).resolves.toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
