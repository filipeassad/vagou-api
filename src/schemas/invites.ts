import { Type } from 'typebox';
import { DateTime } from './common.ts';
import { Email } from './auth.ts';
import { NewAccountFields } from './signup.ts';

const Uuid = Type.String({ format: 'uuid' });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) =>
  Type.Union([schema, Type.Null()]);

const Relation = Type.Union([Type.Literal('owner'), Type.Literal('tenant')], {
  description: 'owner: proprietário; tenant: inquilino',
});

/** Token do convite: vai no corpo, nunca na URL da API (princípio VI). */
const InviteToken = Type.String({ minLength: 20, maxLength: 100 });

export const InviteParams = Type.Object({
  cid: Uuid,
  id: Type.String({ format: 'uuid', description: 'id do convite' }),
});

export const CreateInviteBody = Type.Object(
  {
    unit_id: Uuid,
    unit_relation: Relation,
    can_list_spots: Type.Boolean({
      description:
        'Pode anunciar vagas (req. 17). Inquilino com a regra do condomínio desligada → 409 TENANTS_CANNOT_LIST_SPOTS.',
    }),
  },
  { additionalProperties: false },
);

export const Invite = Type.Object({
  id: Uuid,
  status: Type.Union(
    [
      Type.Literal('pending'),
      Type.Literal('used'),
      Type.Literal('expired'),
      Type.Literal('revoked'),
    ],
    { description: 'pending: ainda pode ser usado' },
  ),
  unit: Type.Object({
    id: Uuid,
    number: Type.String(),
    block: Type.Object({ id: Uuid, name: Type.String() }),
  }),
  unit_relation: Relation,
  can_list_spots: Type.Boolean(),
  created_at: DateTime,
  expires_at: DateTime,
  used_at: Nullable(DateTime),
  revoked_at: Nullable(DateTime),
  recipient_email: Nullable(
    Type.String({ description: 'Para quem a plataforma enviou o convite por último' }),
  ),
  used_by: Nullable(Type.Object({ id: Uuid, name: Type.String() })),
});

export const CreatedInvite = Type.Intersect([
  Invite,
  Type.Object({
    invite_url: Type.String({
      description:
        'Link para o síndico compartilhar. Só aparece nesta resposta: a API guarda apenas o hash do token.',
    }),
  }),
]);

export const InviteList = Type.Object({ items: Type.Array(Invite) });

export const InviteTokenBody = Type.Object({ token: InviteToken }, { additionalProperties: false });

export const AcceptInviteBody = Type.Object(
  { token: InviteToken, ...NewAccountFields },
  { additionalProperties: false },
);

export const PublicInvite = Type.Object({
  condominium: Type.Object({ name: Type.String() }),
  unit: Type.Object({ number: Type.String(), block: Type.Object({ name: Type.String() }) }),
  unit_relation: Relation,
  expires_at: DateTime,
});

export const AcceptedInvite = Type.Object({
  membership_id: Uuid,
  status: Type.Literal('approved'),
  condominium: Type.Object({ id: Uuid, name: Type.String() }),
});

export const SendInviteBody = Type.Object(
  {
    channel: Type.Union([Type.Literal('email'), Type.Literal('whatsapp')], {
      description: 'whatsapp: 422 CHANNEL_UNAVAILABLE até a integração com a Meta existir',
    }),
    recipient: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 100 }),
        email: Type.Optional(Email),
        phone: Type.Optional(Type.String({ minLength: 8, maxLength: 20 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
