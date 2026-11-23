import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { ACCESS } from '../../../../../plugins/app/authorization.ts';
import { CondominiumParams } from '../../../../../schemas/condominiums.ts';
import { FrontDeskAccess, FrontDeskBody } from '../../../../../schemas/front-desk.ts';

const ErrorRef = Type.Ref('ErrorResponse');
const errors = { 401: ErrorRef, 403: ErrorRef, 404: ErrorRef };

// /v1/condominiums/:cid/front-desk: acesso da portaria, só o síndico (req. 4; D12)
const frontDeskRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const config = { access: ACCESS.manager };
  const security = [{ bearerAuth: [] }];

  fastify.get(
    '/',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'E-mail de login da portaria',
        security,
        params: CondominiumParams,
        response: { 200: FrontDeskAccess, ...errors },
      },
      config,
    },
    async (request) => ({
      email: (await fastify.frontDeskService.get(request.params.cid))?.email ?? null,
    }),
  );

  fastify.put(
    '/',
    {
      schema: {
        tags: ['condominiums'],
        summary: 'Criar ou redefinir o acesso da portaria',
        description:
          'Mesmo e-mail: troca a senha. E-mail novo: substitui o acesso anterior. Nos dois casos, as sessões abertas da portaria são encerradas. E-mail de outra conta → 409 FRONT_DESK_EMAIL_IN_USE.',
        security,
        params: CondominiumParams,
        body: FrontDeskBody,
        response: { 200: FrontDeskAccess, 400: ErrorRef, 409: ErrorRef, ...errors },
      },
      config,
    },
    async (request) =>
      fastify.frontDeskService.set(request.params.cid, {
        email: request.body.email,
        password: request.body.password,
        managerId: request.auth!.userId,
      }),
  );
};

export default frontDeskRoutes;
