import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { Unauthenticated } from '../../../plugins/app/authorization.ts';
import { Me } from '../../../schemas/me.ts';

const ErrorRef = Type.Ref('ErrorResponse');

// /v1/me: fora de condomínio, só exige login (vale também para vínculo pendente/recusado).
const meRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['auth'],
        summary: 'Usuário logado e seus vínculos',
        description:
          'Primeira chamada do app depois do login: diz em quais condomínios a pessoa está, com que papel e situação (pendente, aprovado, recusado).',
        security: [{ bearerAuth: [] }],
        response: { 200: Me, 401: ErrorRef },
      },
      onRequest: fastify.authenticate,
    },
    async (request) => {
      const userId = request.auth!.userId;
      const [user, memberships] = await Promise.all([
        fastify.usersRepository.findById(userId),
        fastify.membershipsRepository.listForUser(userId),
      ]);
      if (!user) throw new Unauthenticated();
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        is_admin: user.is_admin,
        memberships,
      };
    },
  );
};

export default meRoutes;
