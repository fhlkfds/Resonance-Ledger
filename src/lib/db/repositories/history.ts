import type { PrismaClient } from '@prisma/client';

export class HistoryRepository {
  constructor(private readonly database: PrismaClient) {}

  listForUser(userId: string, limit: number) {
    return this.database.listeningHistory.findMany({
      where: { spotifyAccount: { userId } },
      orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: { track: true },
    });
  }

  countForUser(userId: string) {
    return this.database.listeningHistory.count({
      where: { spotifyAccount: { userId } },
    });
  }
}
