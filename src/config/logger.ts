import type { FastifyServerOptions } from 'fastify';
import type { DestinationStream } from 'pino';
import type { Config } from './env.ts';

// Campos que nunca podem aparecer em log (D13, princípio VI).
const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwordHash',
  'password_hash',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'refresh_token',
  'email',
  'phone',
  'cpf',
];

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.map((key) => (key.includes('-') ? `["${key}"]` : key)),
  ...SENSITIVE_KEYS.map((key) => (key.includes('-') ? `*["${key}"]` : `*.${key}`)),
];

export function loggerOptions(
  config: Pick<Config, 'LOG_LEVEL'>,
  stream?: DestinationStream,
): FastifyServerOptions['logger'] {
  return {
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    ...(stream ? { stream } : {}),
  };
}
