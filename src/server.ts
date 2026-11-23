import Fastify from 'fastify';
import fp from 'fastify-plugin';
import serviceApp from './app.ts';
import { ConfigError, loadConfig, type Config } from './config/env.ts';
import { loggerOptions } from './config/logger.ts';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const app = Fastify({ logger: loggerOptions(config) });

// fp: decorações do app (db, config) ficam visíveis na instância raiz, como no fastify/demo.
await app.register(fp(serviceApp), { config });

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
