import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { ACCESS, CondominiumNotFound } from '../../../../plugins/app/authorization.ts';
import {
  Condominium,
  CondominiumParams,
  CondominiumPatch,
} from '../../../../schemas/condominiums.ts';

const ErrorRef = Type.Ref('ErrorResponse');

// /v1/condominiums/:cid (login e vínculo exigidos pelo autohooks.ts da pasta acima)
const condominiumRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'Dados básicos do condomínio',
        description: 'Qualquer vínculo aprovado (morador, síndico ou portaria) vê.',
        security: [{ bearerAuth: [] }],
        params: CondominiumParams,
        response: { 200: Condominium, 401: ErrorRef, 403: ErrorRef, 404: ErrorRef },
      },
      config: { access: ACCESS.anyApproved },
    },
    async (request) => {
      const condominium = await fastify.condominiumsRepository.findById(request.params.cid);
      if (!condominium) throw new CondominiumNotFound();
      return condominium;
    },
  );

  fastify.patch(
    '/',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'Alterar dados e configurações do condomínio (síndico)',
        description:
          'Só os campos enviados mudam. Desligar tenants_can_list_spots tira a permissão de anunciar de todos os inquilinos.',
        security: [{ bearerAuth: [] }],
        params: CondominiumParams,
        body: CondominiumPatch,
        response: { 200: Condominium, 400: ErrorRef, 401: ErrorRef, 403: ErrorRef, 404: ErrorRef },
      },
      config: { access: ACCESS.manager },
    },
    async (request) => fastify.condominiumsRepository.update(request.params.cid, request.body),
  );
};

export default condominiumRoutes;
