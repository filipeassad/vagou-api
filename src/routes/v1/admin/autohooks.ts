import type { FastifyInstance } from 'fastify';

/** Toda rota em /v1/admin/* exige login e `is_admin` (plano 001, D11). Sem admin → 403. */
export default async function adminHooks(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.addHook('onRequest', fastify.requireAdmin);
}
