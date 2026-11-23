import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { CondominiumParams } from '../../../../../../schemas/condominiums.ts';
import { AdminTransferManagerBody, ManagerTransfer } from '../../../../../../schemas/manager.ts';

const ErrorRef = Type.Ref('ErrorResponse');

// /v1/admin/condominiums/:cid/manager (login e is_admin exigidos pelo autohooks.ts de /v1/admin)
const adminManagerRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post(
    '/',
    {
      schema: {
        tags: ['admin'],
        summary: 'Passar o papel de síndico para um morador (admin)',
        description:
          'Para quando o síndico saiu sem passar o papel. O novo síndico é indicado pelo e-mail da conta e precisa ser morador aprovado do condomínio.',
        security: [{ bearerAuth: [] }],
        params: CondominiumParams,
        body: AdminTransferManagerBody,
        response: {
          200: ManagerTransfer,
          400: ErrorRef,
          401: ErrorRef,
          403: ErrorRef,
          404: ErrorRef,
          409: ErrorRef,
        },
      },
    },
    async (request) =>
      fastify.managerTransferService.transfer(
        request.params.cid,
        { email: request.body.email },
        null,
      ),
  );
};

export default adminManagerRoutes;
