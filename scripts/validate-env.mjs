#!/usr/bin/env node
/**
 * Strict environment validator shared by deploy.sh and backup.sh.
 *
 * Parses a .env file without `source` or `eval` and reports every problem it
 * finds. It prints variable NAMES and the reason they failed; it never prints
 * a value, so its output is safe in deployment logs and CI transcripts.
 *
 * Exit codes: 0 valid, 1 invalid, 2 the file could not be read.
 *
 * The rules here mirror the Zod schema in src/lib/env.ts. Both are exercised
 * against the same matrix in tests/unit/validate-env.test.ts so they cannot
 * drift apart silently.
 */
import { readFileSync } from 'node:fs';

const PLACEHOLDER = /change_|your_spotify|example\.com|base64_/i;

const problems = [];
const fail = (name, reason) => problems.push(`${name}: ${reason}`);

/**
 * Parse KEY=VALUE lines. Comments and blanks are skipped, surrounding quotes
 * are stripped, and nothing is executed.
 */
export function parseEnvFile(text) {
  const values = {};
  let lineNumber = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      problems.push(`line ${lineNumber}: not a KEY=VALUE assignment`);
      continue;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function requireValue(env, name) {
  const value = env[name];
  if (value === undefined || value === '') {
    fail(name, 'is required but missing or empty');
    return null;
  }
  if (PLACEHOLDER.test(value)) {
    fail(name, 'still contains a placeholder from .env.example');
    return null;
  }
  return value;
}

function integerInRange(env, name, minimum, maximum, { required = true } = {}) {
  const value = env[name];
  if (value === undefined || value === '') {
    if (required) fail(name, 'is required but missing or empty');
    return null;
  }
  if (!/^-?\d+$/.test(value)) {
    fail(name, 'must be an integer');
    return null;
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    fail(name, `must be between ${minimum} and ${maximum}`);
    return null;
  }
  return parsed;
}

/** Exactly 32 bytes of base64, as AES-256-GCM and the session helpers need. */
function base64Key(env, name) {
  const value = requireValue(env, name);
  if (value === null) return null;
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    fail(name, 'must be valid base64');
    return null;
  }
  if (
    bytes.length !== 32 ||
    bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')
  ) {
    fail(name, 'must encode exactly 32 random bytes as base64');
    return null;
  }
  return value;
}

function parseUrl(env, name) {
  const value = requireValue(env, name);
  if (value === null) return null;
  try {
    return new URL(value);
  } catch {
    fail(name, 'must be an absolute URL');
    return null;
  }
}

/** Validates `env` and returns a sorted list of human-readable problems. */
export function validateEnvironment(env) {
  problems.length = 0;

  const nodeEnv = requireValue(env, 'NODE_ENV');
  if (nodeEnv && !['development', 'test', 'production'].includes(nodeEnv))
    fail('NODE_ENV', 'must be development, test, or production');
  const production = nodeEnv === 'production';

  const appUrl = parseUrl(env, 'APP_URL');
  if (appUrl) {
    if (production && appUrl.protocol !== 'https:')
      fail('APP_URL', 'must use HTTPS in production');
    if (appUrl.pathname !== '/' || env.APP_URL.endsWith('/'))
      fail('APP_URL', 'must be an origin with no path or trailing slash');
  }

  integerInRange(env, 'PORT', 1, 65535);
  integerInRange(env, 'HOST_PORT', 1, 65535, { required: false });
  integerInRange(env, 'TRUST_PROXY', 0, 16);

  requireValue(env, 'POSTGRES_DB');
  requireValue(env, 'POSTGRES_USER');
  const postgresPassword = requireValue(env, 'POSTGRES_PASSWORD');
  if (postgresPassword && postgresPassword.length < 24)
    fail('POSTGRES_PASSWORD', 'must be at least 24 characters');

  const databaseUrl = parseUrl(env, 'DATABASE_URL');
  if (databaseUrl) {
    if (!/^postgres(ql)?:$/.test(databaseUrl.protocol))
      fail('DATABASE_URL', 'must use the postgresql scheme');
    if (env.EXTERNAL_DATABASE !== 'true' && databaseUrl.hostname !== 'postgres')
      fail(
        'DATABASE_URL',
        'host must be the Compose service name "postgres" unless EXTERNAL_DATABASE=true',
      );
    if (
      postgresPassword &&
      databaseUrl.password &&
      decodeURIComponent(databaseUrl.password) !== postgresPassword
    )
      fail('DATABASE_URL', 'password does not match POSTGRES_PASSWORD');
    if (env.POSTGRES_USER && databaseUrl.username !== env.POSTGRES_USER)
      fail('DATABASE_URL', 'user does not match POSTGRES_USER');
  }

  const clientId = requireValue(env, 'SPOTIFY_CLIENT_ID');
  if (clientId && clientId.length < 8)
    fail('SPOTIFY_CLIENT_ID', 'is too short to be a real client ID');
  const clientSecret = requireValue(env, 'SPOTIFY_CLIENT_SECRET');
  if (clientSecret && clientSecret.length < 24)
    fail('SPOTIFY_CLIENT_SECRET', 'is too short to be a real client secret');

  const redirectUri = parseUrl(env, 'SPOTIFY_REDIRECT_URI');
  if (redirectUri && appUrl) {
    if (redirectUri.origin !== appUrl.origin)
      fail('SPOTIFY_REDIRECT_URI', 'must share the APP_URL origin exactly');
    if (redirectUri.pathname !== '/api/auth/callback')
      fail('SPOTIFY_REDIRECT_URI', 'path must be /api/auth/callback');
  }

  const sessionSecret = base64Key(env, 'SESSION_SECRET');
  const tokenKey = base64Key(env, 'TOKEN_ENCRYPTION_KEY');
  if (sessionSecret && tokenKey && sessionSecret === tokenKey)
    fail('SESSION_SECRET', 'must differ from TOKEN_ENCRYPTION_KEY');

  const keyVersion = requireValue(env, 'TOKEN_ENCRYPTION_KEY_VERSION');
  if (keyVersion && !/^v[1-9]\d*$/.test(keyVersion))
    fail('TOKEN_ENCRYPTION_KEY_VERSION', 'must look like v1, v2, and so on');

  const interval = integerInRange(env, 'SYNC_INTERVAL_SECONDS', 60, 900);
  const overlap = integerInRange(env, 'SYNC_OVERLAP_SECONDS', 60, 900, {
    required: false,
  });
  if (interval !== null && overlap !== null && overlap < interval)
    fail('SYNC_OVERLAP_SECONDS', 'must be at least SYNC_INTERVAL_SECONDS');

  integerInRange(env, 'DATA_RETENTION_DAYS', 1, 3650);
  integerInRange(env, 'SYNC_RUN_RETENTION_DAYS', 1, 3650, { required: false });
  integerInRange(env, 'BACKUP_RETENTION_DAYS', 1, 3650, { required: false });

  if (
    env.LOG_LEVEL &&
    !['trace', 'debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL)
  )
    fail('LOG_LEVEL', 'must be trace, debug, info, warn, or error');

  if (env.APP_VERSION === 'latest')
    fail('APP_VERSION', 'must not be "latest" in production');

  if (env.BACKUP_DIR && !env.BACKUP_DIR.startsWith('/'))
    fail('BACKUP_DIR', 'must be an absolute path');

  if (
    env.BACKUP_BEFORE_DEPLOY &&
    !['true', 'false'].includes(env.BACKUP_BEFORE_DEPLOY)
  )
    fail('BACKUP_BEFORE_DEPLOY', 'must be true or false');

  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('NEXT_PUBLIC_') && PLACEHOLDER.test(value))
      fail(name, 'is a public variable holding a placeholder');
  }

  return [...problems].sort();
}

// Only run as a CLI when invoked directly, so tests can import the functions.
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split('/').pop())
) {
  const path = process.argv[2] ?? '.env';
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.error(`[ERROR] cannot read environment file: ${path}`);
    process.exit(2);
  }
  const found = validateEnvironment(parseEnvFile(text));
  if (found.length) {
    console.error(`[ERROR] ${found.length} environment problem(s) in ${path}:`);
    for (const problem of found) console.error(`[ERROR]   ${problem}`);
    process.exit(1);
  }
  console.log('[OK] environment configuration is valid');
}
