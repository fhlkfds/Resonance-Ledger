import type { PrismaClient } from '@prisma/client';

export function disconnectUser(
  database: PrismaClient,
  userId: string,
  now = new Date(),
) {
  return database.$transaction(async (transaction) => {
    await transaction.spotifyAccount.updateMany({
      where: { userId },
      data: { state: 'DELETING' },
    });
    await transaction.appSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await transaction.spotifyAccount.deleteMany({ where: { userId } });
    await transaction.track.deleteMany({ where: { history: { none: {} } } });
    await transaction.album.deleteMany({ where: { tracks: { none: {} } } });
    await transaction.artist.deleteMany({
      where: { tracks: { none: {} }, albums: { none: {} } },
    });
    await transaction.user.update({
      where: { id: userId },
      data: { status: 'DISCONNECTED' },
    });
  });
}
