import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { DestinationStream } from 'pino';
import serviceApp from '../src/app.ts';
import type { Config } from '../src/config/env.ts';
import { loggerOptions } from '../src/config/logger.ts';
import { isMemoryNotifier } from '../src/plugins/app/notifications/memory-notifier.ts';
import { TEST_DATABASE_URL } from './test-database.ts';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: 'test-secret-with-at-least-32-characters!!',
    WEB_ORIGIN: 'http://localhost:5173',
    NOTIFIER: 'memory',
    ...overrides,
  };
}

/** Monta a aplicação como o server.ts, sem abrir porta (testes usam app.inject). */
export async function buildTestApp(
  options: {
    config?: Partial<Config>;
    logStream?: DestinationStream;
    /** Registra rotas extras só para o teste, antes do `ready()`. */
    beforeReady?: (app: FastifyInstance) => Promise<void> | void;
  } = {},
) {
  const config = testConfig(options.config);
  const app = Fastify({ logger: loggerOptions(config, options.logStream) });
  // fp: decorações do app (db, config) ficam visíveis na instância raiz, como no fastify/demo.
  await app.register(fp(serviceApp), { config });
  await options.beforeReady?.(app);
  await app.ready();
  return app;
}

/** Notificações enviadas pelo app de teste (NOTIFIER=memory), na ordem de envio. */
export function sentNotifications(app: FastifyInstance) {
  if (!isMemoryNotifier(app.notifier)) {
    throw new Error('sentNotifications exige o app de teste com NOTIFIER=memory');
  }
  return app.notifier.sent;
}

/** Stream que guarda cada linha de log (JSON) para inspeção nos testes. */
export function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(...chunk.toString().split('\n').filter(Boolean));
      callback();
    },
  });
  return { stream, lines, text: () => lines.join('\n') };
}
