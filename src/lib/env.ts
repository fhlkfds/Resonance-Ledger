import { z } from 'zod';

const placeholderPattern = /change_|your_spotify|example\.com|base64_/i;
const base64Key = z.string().transform((value, ctx) => {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be valid base64' });
    return z.NEVER;
  }
  if (
    bytes.length !== 32 ||
    bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')
  ) {
    ctx.addIssue({ code: 'custom', message: 'must encode exactly 32 bytes' });
    return z.NEVER;
  }
  return value;
});

const booleanText = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');
const int = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    APP_URL: z.url(),
    PORT: int(1, 65_535),
    HOST_PORT: int(1, 65_535).default(3000),
    BIND_ADDRESS: z.string().default('127.0.0.1'),
    POSTGRES_DB: z.string().min(1),
    POSTGRES_USER: z.string().min(1),
    POSTGRES_PASSWORD: z.string().min(24),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // Bound the pool and cap statement runtime (spec §18). Applied to the
    // connection string by src/lib/db/client.ts.
    DATABASE_POOL_SIZE: int(1, 100).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: int(1_000, 120_000).default(10_000),
    SPOTIFY_CLIENT_ID: z.string().min(8),
    SPOTIFY_CLIENT_SECRET: z.string().min(24),
    SPOTIFY_REDIRECT_URI: z.url(),
    SESSION_SECRET: base64Key,
    TOKEN_ENCRYPTION_KEY: base64Key,
    TOKEN_ENCRYPTION_KEY_VERSION: z.string().regex(/^v[1-9]\d*$/),
    // §17 key rotation: the superseded key stays readable until the batch
    // rotation job has re-encrypted every envelope under the active version.
    // Both are optional, and must be supplied together.
    TOKEN_ENCRYPTION_KEY_PREVIOUS: base64Key.optional(),
    TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION: z
      .string()
      .regex(/^v[1-9]\d*$/)
      .optional(),
    SYNC_INTERVAL_SECONDS: int(60, 900),
    SYNC_OVERLAP_SECONDS: int(60, 900).default(300),
    DATA_RETENTION_DAYS: int(1, 3650),
    SYNC_RUN_RETENTION_DAYS: int(1, 3650).default(90),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error'])
      .default('info'),
    TRUST_PROXY: int(0, 16),
    TZ: z.string().default('UTC'),
    APP_IMAGE: z.string().default('resonance-ledger'),
    APP_VERSION: z
      .string()
      .refine((value) => value !== 'latest', 'latest is not allowed'),
    BACKUP_DIR: z
      .string()
      .startsWith('/')
      .default('/var/backups/resonance-ledger'),
    BACKUP_RETENTION_DAYS: int(1, 3650).default(30),
    BACKUP_BEFORE_DEPLOY: booleanText.default(true),
    EXTERNAL_DATABASE: booleanText.default(false),
  })
  .superRefine((environment, ctx) => {
    for (const [name, value] of Object.entries(environment)) {
      if (typeof value === 'string' && placeholderPattern.test(value)) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'placeholder value is not allowed',
        });
      }
    }

    const appUrl = new URL(environment.APP_URL);
    const callback = new URL(environment.SPOTIFY_REDIRECT_URI);
    if (environment.NODE_ENV === 'production' && appUrl.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'must use HTTPS in production',
      });
    }
    if (
      callback.origin !== appUrl.origin ||
      callback.pathname !== '/api/auth/callback'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SPOTIFY_REDIRECT_URI'],
        message: 'must match APP_URL origin and callback path',
      });
    }
    if (environment.SESSION_SECRET === environment.TOKEN_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'must differ from token encryption key',
      });
    }
    const previousKey = environment.TOKEN_ENCRYPTION_KEY_PREVIOUS;
    const previousVersion = environment.TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION;
    // A key without its version, or a version without its key, silently
    // disables rotation and bricks every envelope written under the old key.
    if (Boolean(previousKey) !== Boolean(previousVersion)) {
      ctx.addIssue({
        code: 'custom',
        path: [
          previousKey
            ? 'TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION'
            : 'TOKEN_ENCRYPTION_KEY_PREVIOUS',
        ],
        message: 'previous key and previous key version must be set together',
      });
    }
    if (
      previousVersion &&
      previousVersion === environment.TOKEN_ENCRYPTION_KEY_VERSION
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['TOKEN_ENCRYPTION_KEY_PREVIOUS_VERSION'],
        message: 'must differ from TOKEN_ENCRYPTION_KEY_VERSION',
      });
    }
    if (previousKey && previousKey === environment.TOKEN_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['TOKEN_ENCRYPTION_KEY_PREVIOUS'],
        message: 'must differ from TOKEN_ENCRYPTION_KEY',
      });
    }
    if (environment.SYNC_OVERLAP_SECONDS < environment.SYNC_INTERVAL_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SYNC_OVERLAP_SECONDS'],
        message: 'must be at least SYNC_INTERVAL_SECONDS',
      });
    }
    if (
      !environment.EXTERNAL_DATABASE &&
      new URL(environment.DATABASE_URL).hostname !== 'postgres'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'database hostname must be postgres',
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(input: NodeJS.ProcessEnv): Environment {
  return environmentSchema.parse(input);
}

let cachedEnvironment: Environment | undefined;

export function getEnvironment(): Environment {
  cachedEnvironment ??= parseEnvironment(process.env);
  return cachedEnvironment;
}
