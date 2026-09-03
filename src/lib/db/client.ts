import { PrismaClient } from '@prisma/client';

const globalDatabase = globalThis as unknown as { prisma?: PrismaClient };

export const database = globalDatabase.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalDatabase.prisma = database;
}
