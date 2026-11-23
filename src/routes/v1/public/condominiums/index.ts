import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import {
  PendingMembership,
  PublicCodeParams,
  PublicCondominium,
  SignupBody,
} from '../../../../schemas/signup.ts';

const ErrorRef = Type.Ref('ErrorResponse');

// /v1/public/condominiums/:code: cadastro pelo link/QR Code, sem login (req. 6–9)
const publicCondominiumRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    '/:code',
    {
      schema: {
        tags: ['public'],
        summary: 'Condomínio do QR Code, com blocos e unidades para o cadastro',
        description: 'Código inexistente → 404 CONDOMINIUM_NOT_FOUND.',
        params: PublicCodeParams,
        response: { 200: PublicCondominium, 404: ErrorRef, 429: ErrorRef },
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => fastify.signupService.publicInfo(request.params.code),
  );

  fastify.post(
    '/:code/signup',
    {
      schema: {
        tags: ['public'],
        summary: 'Cadastro pelo QR Code: cria a conta com vínculo pendente',
        description:
          'O síndico é avisado e precisa aprovar. Não faz login: o app chama POST /v1/auth/login em seguida. E-mail já cadastrado → 409 EMAIL_ALREADY_REGISTERED (quem tem conta entra e usa POST /v1/me/memberships). Unidade de outro condomínio → 404 UNIT_NOT_FOUND.',
        params: PublicCodeParams,
        body: SignupBody,
        response: {
          201: PendingMembership,
          400: ErrorRef,
          404: ErrorRef,
          409: ErrorRef,
          429: ErrorRef,
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { name, email, phone, password, unit_id, unit_relation } = request.body;
      const pending = await fastify.signupService.signup(request.params.code, {
        name,
        email,
        phone,
        password,
        unitId: unit_id,
        unitRelation: unit_relation,
      });
      return reply.code(201).send({ membership_id: pending.membershipId, status: 'pending' });
    },
  );
};

export default publicCondominiumRoutes;
