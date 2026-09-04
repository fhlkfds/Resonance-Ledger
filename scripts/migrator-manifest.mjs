/**
 * Writes the minimal package.json for the migrator image.
 *
 * Applying migrations needs only the Prisma CLI and Prisma Client. Installing
 * the full production tree would pull in Next, React, and ECharts, none of
 * which take part in a migration. Versions are copied from the repository
 * manifest so the CLI stays pinned to the version the project declares.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const source = JSON.parse(readFileSync('package.source.json', 'utf8'));
const prismaCli = source.devDependencies?.prisma;
const prismaClient = source.dependencies?.['@prisma/client'];

if (!prismaCli || !prismaClient) {
  console.error('package.json is missing a pinned prisma or @prisma/client');
  process.exit(1);
}

writeFileSync(
  'package.json',
  `${JSON.stringify(
    {
      name: 'resonance-ledger-migrator',
      version: source.version,
      private: true,
      dependencies: { prisma: prismaCli, '@prisma/client': prismaClient },
    },
    null,
    2,
  )}\n`,
);

console.log(
  `migrator manifest: prisma@${prismaCli}, @prisma/client@${prismaClient}`,
);
