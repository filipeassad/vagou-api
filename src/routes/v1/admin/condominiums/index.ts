import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import {
  AdminCondominium,
  AdminCondominiumList,
  CreateCondominiumBody,
} from '../../../../schemas/admin.ts';

const ErrorRef = Type.Ref('ErrorResponse');
const errors = { 401: ErrorRef, 403: ErrorRef };

// /v1/admin/condominiums (login e is_admin exigidos pelo autohooks.ts da pasta acima)
const adminCondominiumRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['admin'],
        summary: 'Lista os condomínios com o síndico de cada um',
        security: [{ bearerAuth: [] }],
        response: { 200: AdminCondominiumList, ...errors },
      },
    },
    async () => ({ items: await fastify.adminService.listCondominiums() }),
  );

  fastify.post(
    '/',
    {
      schema: {
        tags: ['admin'],
        summary: 'Cadastra condomínio e síndico',
        description:
          'Cria o condomínio, o código do QR Code e o síndico (aprovado). E-mail novo: cria a conta sem senha e envia o link para definir a senha (vale 7 dias; usa POST /v1/auth/reset-password). E-mail já cadastrado: usa a conta existente. Blocos e unidades são cadastrados depois pelo síndico.',
        security: [{ bearerAuth: [] }],
        body: CreateCondominiumBody,
        response: { 201: AdminCondominium, 400: ErrorRef, ...errors },
      },
    },
    async (request, reply) => {
      const condominium = await fastify.adminService.createCondominium(request.body);
      return reply.code(201).send(condominium);
    },
  );
};

export default adminCondominiumRoutes;
