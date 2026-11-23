import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';

// GET /v1/health (o prefixo vem do caminho da pasta: routes/v1/health)
const healthRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['health'],
        summary: 'Verifica se a API está no ar',
        response: {
          200: Type.Object({ status: Type.Literal('ok') }),
        },
      },
    },
    async () => ({ status: 'ok' as const }),
  );
};

export default healthRoutes;
