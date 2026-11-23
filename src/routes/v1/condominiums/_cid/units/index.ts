import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { ACCESS } from '../../../../../plugins/app/authorization.ts';
import {
  CondominiumParams,
  Unit,
  UnitCreateBody,
  UnitParams,
  UnitPatchBody,
} from '../../../../../schemas/condominiums.ts';

const ErrorRef = Type.Ref('ErrorResponse');
const errors = { 401: ErrorRef, 403: ErrorRef, 404: ErrorRef };

// /v1/condominiums/:cid/units: só o síndico (req. 2). A lista fica em GET .../blocks.
const unitRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const config = { access: ACCESS.manager };
  const security = [{ bearerAuth: [] }];

  fastify.post(
    '/',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'Criar unidade',
        description: 'Número repetido no mesmo bloco → 409 UNIT_NUMBER_TAKEN.',
        security,
        params: CondominiumParams,
        body: UnitCreateBody,
        response: { 201: Unit, 400: ErrorRef, 409: ErrorRef, ...errors },
      },
      config,
    },
    async (request, reply) => {
      const unit = await fastify.unitsRepository.create(request.params.cid, {
        blockId: request.body.block_id,
        number: request.body.number,
      });
      return reply.code(201).send(unit);
    },
  );

  fastify.patch(
    '/:unitId',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'Corrigir o número ou mover a unidade de bloco',
        description: 'Os moradores continuam vinculados à unidade.',
        security,
        params: UnitParams,
        body: UnitPatchBody,
        response: { 200: Unit, 400: ErrorRef, 409: ErrorRef, ...errors },
      },
      config,
    },
    async (request) =>
      fastify.unitsRepository.update(request.params.cid, request.params.unitId, {
        blockId: request.body.block_id,
        number: request.body.number,
      }),
  );

  fastify.delete(
    '/:unitId',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'Apagar unidade nunca usada',
        description:
          'Com morador pendente/aprovado → 409 UNIT_HAS_RESIDENTS. Que já teve morador ou convite → 409 UNIT_HAS_HISTORY (corrija o número com PATCH).',
        security,
        params: UnitParams,
        response: { 204: Type.Null({ description: 'Apagada' }), 409: ErrorRef, ...errors },
      },
      config,
    },
    async (request, reply) => {
      await fastify.unitsRepository.delete(request.params.cid, request.params.unitId);
      return reply.code(204).send(null);
    },
  );
};

export default unitRoutes;
