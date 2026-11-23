import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { ACCESS } from '../../../../../plugins/app/authorization.ts';
import { CondominiumParams } from '../../../../../schemas/condominiums.ts';
import {
  CreateInviteBody,
  CreatedInvite,
  InviteList,
  InviteParams,
  SendInviteBody,
} from '../../../../../schemas/invites.ts';

const ErrorRef = Type.Ref('ErrorResponse');
const errors = { 401: ErrorRef, 403: ErrorRef, 404: ErrorRef };

// /v1/condominiums/:cid/invites: convites individuais, só o síndico (req. 10, 13, 14, 17)
const inviteRoutes: FastifyPluginAsyncTypebox = async (fastify) => {
  const config = { access: ACCESS.manager };
  const security = [{ bearerAuth: [] }];

  fastify.post(
    '/',
    {
      schema: {
        tags: ['invites'],
        summary: 'Gerar convite para uma unidade',
        description:
          'Uso único; vale pelos dias de invite_validity_days do condomínio. Devolve o link para o síndico compartilhar (só nesta resposta).',
        security,
        params: CondominiumParams,
        body: CreateInviteBody,
        response: { 201: CreatedInvite, 400: ErrorRef, 409: ErrorRef, ...errors },
      },
      config,
    },
    async (request, reply) => {
      const invite = await fastify.invitesService.create({
        condominiumId: request.params.cid,
        unitId: request.body.unit_id,
        unitRelation: request.body.unit_relation,
        canListSpots: request.body.can_list_spots,
        createdBy: request.auth!.userId,
      });
      return reply.code(201).send(invite);
    },
  );

  fastify.get(
    '/',
    {
      schema: {
        tags: ['invites'],
        summary: 'Convites do condomínio e a situação de cada um',
        security,
        params: CondominiumParams,
        response: { 200: InviteList, ...errors },
      },
      config,
    },
    async (request) => ({ items: await fastify.invitesService.list(request.params.cid) }),
  );

  fastify.post(
    '/:id/send',
    {
      schema: {
        tags: ['invites'],
        summary: 'Enviar o convite pela plataforma (e-mail)',
        description:
          'Gera um link novo: o anterior deixa de valer (a API guarda só o hash). Só convite pendente (senão 409 INVITE_NOT_SENDABLE). Canal whatsapp → 422 CHANNEL_UNAVAILABLE. Falha do fornecedor → 502 INVITE_SEND_FAILED.',
        security,
        params: InviteParams,
        body: SendInviteBody,
        response: {
          200: CreatedInvite,
          400: ErrorRef,
          409: ErrorRef,
          422: ErrorRef,
          429: ErrorRef,
          502: ErrorRef,
          ...errors,
        },
      },
      config: { ...config, rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) =>
      fastify.invitesService.send(request.params.cid, request.params.id, request.body),
  );

  fastify.post(
    '/:id/revoke',
    {
      schema: {
        tags: ['invites'],
        summary: 'Cancelar convite ainda não usado',
        description: 'Já usado ou já cancelado → 409 INVITE_NOT_REVOCABLE.',
        security,
        params: InviteParams,
        response: { 204: Type.Null({ description: 'Cancelado' }), 409: ErrorRef, ...errors },
      },
      config,
    },
    async (request, reply) => {
      await fastify.invitesService.revoke(request.params.cid, request.params.id);
      return reply.code(204).send(null);
    },
  );
};

export default inviteRoutes;
