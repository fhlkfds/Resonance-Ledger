import type { PrismaClient } from '@prisma/client';

export class EntityRepository {
  constructor(private readonly database: PrismaClient) {}

  findTrackForUser(userId: string, trackId: string) {
    return this.database.track.findFirst({
      where: {
        id: trackId,
        history: { some: { spotifyAccount: { userId } } },
      },
      include: {
        album: true,
        artists: { orderBy: { position: 'asc' }, include: { artist: true } },
      },
    });
  }

  findArtistForUser(userId: string, artistId: string) {
    return this.database.artist.findFirst({
      where: {
        id: artistId,
        tracks: {
          some: {
            track: { history: { some: { spotifyAccount: { userId } } } },
          },
        },
      },
    });
  }

  findAlbumForUser(userId: string, albumId: string) {
    return this.database.album.findFirst({
      where: {
        id: albumId,
        tracks: { some: { history: { some: { spotifyAccount: { userId } } } } },
      },
    });
  }
}
