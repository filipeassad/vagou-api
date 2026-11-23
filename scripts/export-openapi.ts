/**
 * Gera o contrato da API em openapi.json (raiz do repositório). Uso: npm run openapi:export
 *
 * Monta a aplicação sem subir o servidor e sem conectar no banco (o pool do Postgres só
 * conecta na primeira consulta), então não precisa de .env nem de Docker.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import serviceApp from '../src/app.ts';
import { loadConfig } from '../src/config/env.ts';

export const OPENAPI_FILE = path.resolve(import.meta.dirname, '../openapi.json');

// NODE_ENV=test: sem Swagger UI e sem exigir o notificador de e-mail de produção.
const config = loadConfig({
  NODE_ENV: 'test',
  NOTIFIER: 'memory',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://unused@localhost/unused',
  JWT_SECRET: 'x'.repeat(32),
});

const app = Fastify({ logger: false });
await app.register(fp(serviceApp), { config });
await app.ready();

const spec = app.swagger();
await writeFile(OPENAPI_FILE, `${JSON.stringify(spec, null, 2)}\n`, 'utf-8');
await app.close();

console.log(
  `✔ ${path.relative(process.cwd(), OPENAPI_FILE)} (${Object.keys(spec.paths ?? {}).length} rotas)`,
);
