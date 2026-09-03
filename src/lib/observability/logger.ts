import pino from 'pino';

const redactPaths = [
  '*.accessToken',
  '*.refreshToken',
  '*.authorization',
  '*.cookie',
  '*.code',
  '*.clientSecret',
  '*.databaseUrl',
  '*.password',
  '*.sessionSecret',
  '*.tokenEncryptionKey',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'code',
  'clientSecret',
  'databaseUrl',
  'password',
  'sessionSecret',
  'tokenEncryptionKey',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: process.env.SERVICE_NAME ?? 'app',
    version: process.env.APP_VERSION ?? 'development',
  },
  redact: { paths: redactPaths, censor: '[REDACTED]' },
});
