import { execFileSync } from 'node:child_process';

export default function globalSetup() {
  const databaseUrl =
    process.env.E2E_DATABASE_URL ??
    'postgresql://resonance:resonance-e2e-password-long@127.0.0.1:5432/resonance_e2e?schema=public';
  execFileSync('./node_modules/.bin/prisma', ['migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}
