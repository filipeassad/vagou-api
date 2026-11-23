import type { FastifyInstance } from 'fastify';

/**
 * Vale para TODAS as rotas em /v1/condominiums/* (princípio I, plano 001 D8):
 * 1. exige login (access token válido e sessão ativa);
 * 2. exige vínculo com o `:cid` da URL e aplica a regra `config.access` da rota
 *    (padrão: morador ou síndico aprovado). Sem vínculo → 404.
 */
export default async function condominiumsHooks(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.addHook('onRequest', fastify.authorizeCondominium);
}
