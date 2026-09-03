import { PrismaClient } from '@prisma/client';

const database = new PrismaClient();
try {
  await database.$queryRaw`SELECT 1`;
  process.exitCode = 0;
} catch {
  process.exitCode = 1;
} finally {
  await database.$disconnect();
}
