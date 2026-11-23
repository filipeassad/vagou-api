import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Contrato OpenAPI gerado a partir dos schemas das rotas (plano 001, D1).
 * - O JSON fica em GET /v1/openapi.json (routes/v1/index.ts) e é exportado por
 *   `npm run openapi:export`.
 * - A tela de documentação (Swagger UI) só existe em desenvolvimento: GET /docs
 */
export default fp(
  async function swagger(fastify: FastifyInstance) {
    await fastify.register(fastifySwagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'Vagou API',
          description: 'Aluguel interno de vagas em condomínios.',
          version: '1.0.0',
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
      },
      // Rotas '/' dentro de uma pasta (routes/v1/health) atendem /v1/health e /v1/health/;
      // o contrato mostra só a forma sem barra no fim.
      transform: ({ schema, url }) => ({
        schema,
        url: url.length > 1 ? url.replace(/\/$/, '') : url,
      }),
      // Schemas registrados com fastify.addSchema viram components/schemas com o nome do $id.
      refResolver: {
        buildLocalReference: (json, _baseUri, _fragment, i) =>
          typeof json.$id === 'string' ? json.$id : `def-${i}`,
      },
    });

    if (fastify.config.NODE_ENV === 'development') {
      await fastify.register(fastifySwaggerUi, { routePrefix: '/docs' });
    }
  },
  { name: 'swagger' },
);
