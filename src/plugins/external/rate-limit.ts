import fastifyRateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';

/**
 * Limite de requisições por IP (plano 001, D7), em memória (uma instância da API).
 * Desligado por padrão: cada rota sensível liga com `config: { rateLimit: {...} }`.
 * O 429 sai no formato padrão de erro (RATE_LIMITED) pelo error handler do app.ts.
 *
 * Atenção ao publicar atrás de proxy/CDN: configurar `trustProxy` no Fastify, senão
 * todos os usuários parecem ter o mesmo IP (o do proxy).
 */
export default fp(
  async function rateLimit(fastify) {
    await fastify.register(fastifyRateLimit, { global: false });
  },
  { name: 'rate-limit' },
);
