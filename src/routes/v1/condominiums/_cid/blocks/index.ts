import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { ACCESS } from '../../../../../plugins/app/authorization.ts';
import {
  Block,
  BlockBody,
  BlockList,
  BlockParams,
  CondominiumParams,
} from '../../../../../schemas/condominiums.ts';

const ErrorRef = Type.Ref('ErrorResponse');
const errors = { 401: ErrorRef, 403: ErrorRef, 404: ErrorRef };

// /v1/condominiums/:cid/blocks: só o síndico (req. 2)
const blockRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const config = { access: ACCESS.manager };
  const security = [{ bearerAuth: [] }];

  fastify.get(
    '/',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'Blocos e unidades do condomínio',
        security,
        params: CondominiumParams,
        response: { 200: BlockList, ...errors },
      },
      config,
    },
    async (request) => ({
      items: await fastify.blocksRepository.listWithUnits(request.params.cid),
    }),
  );

  fastify.post(
    '/',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'Criar bloco/torre',
        security,
        params: CondominiumParams,
        body: BlockBody,
        response: { 201: Block, 400: ErrorRef, 409: ErrorRef, ...errors },
      },
      config,
    },
    async (request, reply) => {
      const block = await fastify.blocksRepository.create(request.params.cid, request.body.name);
      return reply.code(201).send(block);
    },
  );

  fastify.patch(
    '/:blockId',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'Renomear bloco/torre',
        security,
        params: BlockParams,
        body: BlockBody,
        response: { 200: Block, 400: ErrorRef, 409: ErrorRef, ...errors },
      },
      config,
    },
    async (request) =>
      fastify.blocksRepository.rename(
        request.params.cid,
        request.params.blockId,
        request.body.name,
      ),
  );

  fastify.delete(
    '/:blockId',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'Apagar bloco/torre vazio',
        description: 'Bloco com unidades → 409 BLOCK_NOT_EMPTY.',
        security,
        params: BlockParams,
        response: { 204: Type.Null({ description: 'Apagado' }), 409: ErrorRef, ...errors },
      },
      config,
    },
    async (request, reply) => {
      await fastify.blocksRepository.delete(request.params.cid, request.params.blockId);
      return reply.code(204).send(null);
    },
  );
};

export default blockRoutes;
