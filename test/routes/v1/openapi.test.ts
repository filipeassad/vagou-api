import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../../helper.ts';

type Spec = { paths: Record<string, Record<string, unknown>> };

/** "METHOD /caminho" de cada rota, com `{cid}` escrito como `:cid`. */
function routes(spec: Spec) {
  return Object.entries(spec.paths)
    .flatMap(([path, methods]) =>
      Object.keys(methods).map(
        (method) => `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`,
      ),
    )
    .sort();
}

/** Seção 4 do plano 001 (T21). Rota nova da spec 001 entra aqui e na tabela do plano. */
const PLAN_001_ROUTES = [
  'GET /v1/public/condominiums/:code',
  'POST /v1/public/condominiums/:code/signup',
  'POST /v1/public/invites/lookup',
  'POST /v1/public/invites/accept',
  'POST /v1/auth/login',
  'POST /v1/auth/refresh',
  'POST /v1/auth/logout',
  'POST /v1/auth/forgot-password',
  'POST /v1/auth/reset-password',
  'GET /v1/me',
  'POST /v1/me/memberships',
  'POST /v1/me/invites/accept',
  'POST /v1/admin/condominiums',
  'GET /v1/admin/condominiums',
  'POST /v1/admin/condominiums/:cid/manager',
  'GET /v1/condominiums/:cid',
  'PATCH /v1/condominiums/:cid',
  'GET /v1/condominiums/:cid/blocks',
  'POST /v1/condominiums/:cid/blocks',
  'PATCH /v1/condominiums/:cid/blocks/:blockId',
  'DELETE /v1/condominiums/:cid/blocks/:blockId',
  'POST /v1/condominiums/:cid/units',
  'PATCH /v1/condominiums/:cid/units/:unitId',
  'DELETE /v1/condominiums/:cid/units/:unitId',
  'GET /v1/condominiums/:cid/memberships',
  'POST /v1/condominiums/:cid/memberships/:id/approve',
  'POST /v1/condominiums/:cid/memberships/:id/reject',
  'POST /v1/condominiums/:cid/memberships/:id/remove',
  'PATCH /v1/condominiums/:cid/memberships/:id',
  'PATCH /v1/condominiums/:cid/memberships/me',
  'POST /v1/condominiums/:cid/manager',
  'POST /v1/condominiums/:cid/invites',
  'GET /v1/condominiums/:cid/invites',
  'POST /v1/condominiums/:cid/invites/:id/revoke',
  'POST /v1/condominiums/:cid/invites/:id/send',
  'GET /v1/condominiums/:cid/front-desk',
  'PUT /v1/condominiums/:cid/front-desk',
];

describe('GET /v1/openapi.json', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('devolve o contrato OpenAPI 3.1 com as rotas e o schema de erro', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });

    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths).toHaveProperty('/v1/health');
    expect(spec.paths).not.toHaveProperty('/v1/openapi.json');
    expect(spec.components.schemas).toHaveProperty('ErrorResponse');
  });

  it('tem todas as rotas da seção 4 do plano 001, e nenhuma além delas e do health', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/v1/openapi.json' })).json() as Spec;

    expect(routes(spec)).toEqual([...PLAN_001_ROUTES, 'GET /v1/health'].sort());
  });

  it('o openapi.json do repositório está em dia com o código (rodar npm run openapi:export)', async () => {
    const served = (await app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
    const committed = JSON.parse(
      await readFile(new URL('../../../openapi.json', import.meta.url), 'utf8'),
    );

    expect(committed).toEqual(served);
  });

  it('não expõe a Swagger UI fora de desenvolvimento', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });

    expect(res.statusCode).toBe(404);
  });
});

describe('Swagger UI em desenvolvimento', () => {
  it('responde em /docs', async () => {
    const app = await buildTestApp({ config: { NODE_ENV: 'development' } });
    try {
      const res = await app.inject({ method: 'GET', url: '/docs/' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
