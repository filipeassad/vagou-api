import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { ACCESS } from '../../../../../plugins/app/authorization.ts';
import { CondominiumParams } from '../../../../../schemas/condominiums.ts';
import { ManagerTransfer, TransferManagerBody } from '../../../../../schemas/manager.ts';

const ErrorRef = Type.Ref('ErrorResponse');

// /v1/condominiums/:cid/manager: o síndico atual passa o papel (req. 5)
const managerRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post(
    '/',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'Passar o papel de síndico para um morador',
        description:
          'O destino precisa ser morador aprovado (senão 409 NOT_APPROVED_RESIDENT). O síndico atual vira morador da unidade dele e perde as permissões na hora.',
        security: [{ bearerAuth: [] }],
        params: CondominiumParams,
        body: TransferManagerBody,
        response: {
          200: ManagerTransfer,
          400: ErrorRef,
          401: ErrorRef,
          403: ErrorRef,
          404: ErrorRef,
          409: ErrorRef,
        },
      },
      config: { access: ACCESS.manager },
    },
    async (request) =>
      fastify.managerTransferService.transfer(
        request.params.cid,
        { membershipId: request.body.membership_id },
        request.auth!.userId,
      ),
  );
};

export default managerRoutes;
