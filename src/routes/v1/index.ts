import type { FastifyInstance } from 'fastify';

// GET /v1/openapi.json: o contrato da API (plano 001, D1). Fica fora do próprio contrato (hide).
export default async function v1Routes(fastify: FastifyInstance) {
  fastify.get('/openapi.json', { schema: { hide: true } }, async () => fastify.swagger());
}
