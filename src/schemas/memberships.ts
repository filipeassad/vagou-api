import { Type } from 'typebox';
import { DateTime } from './common.ts';

const Uuid = Type.String({ format: 'uuid' });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) =>
  Type.Union([schema, Type.Null()]);

const Relation = Type.Union([Type.Literal('owner'), Type.Literal('tenant')], {
  description: 'owner: proprietário; tenant: inquilino',
});

const ListableStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('approved'),
  Type.Literal('rejected'),
]);

export const MembershipParams = Type.Object({
  cid: Uuid,
  id: Type.String({ format: 'uuid', description: 'id do vínculo' }),
});

export const MembershipListQuery = Type.Object({
  status: Type.Optional(ListableStatus),
});

/** Visão do síndico: contato do morador para tirar dúvidas antes de aprovar. */
export const ResidentListItem = Type.Object({
  id: Uuid,
  role: Type.Union([Type.Literal('resident'), Type.Literal('manager')]),
  status: ListableStatus,
  unit_relation: Nullable(Relation),
  can_list_spots: Type.Boolean(),
  rejection_reason: Nullable(Type.String()),
  created_at: DateTime,
  decided_at: Nullable(DateTime),
  user: Type.Object({
    id: Uuid,
    name: Type.String(),
    email: Type.String(),
    phone: Nullable(Type.String()),
  }),
  unit: Nullable(
    Type.Object({
      id: Uuid,
      number: Type.String(),
      block: Type.Object({ id: Uuid, name: Type.String() }),
    }),
  ),
});

export const ResidentList = Type.Object({ items: Type.Array(ResidentListItem) });

export const ApproveBody = Type.Object(
  {
    can_list_spots: Type.Boolean({
      description:
        'Pode anunciar vagas (req. 17). Inquilino com a regra do condomínio desligada → 409 TENANTS_CANNOT_LIST_SPOTS.',
    }),
  },
  { additionalProperties: false },
);

export const RejectBody = Type.Object(
  { reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })) },
  { additionalProperties: false },
);

export const CanListSpotsBody = Type.Object(
  { can_list_spots: Type.Boolean() },
  { additionalProperties: false },
);

export const ResubmitBody = Type.Object(
  { unit_id: Type.Optional(Uuid), unit_relation: Type.Optional(Relation) },
  {
    additionalProperties: false,
    description: 'Campos a corrigir. Corpo vazio reenvia sem mudanças.',
  },
);
