import { Type, type Static } from 'typebox';

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) =>
  Type.Union([schema, Type.Null()]);

export const MyMembership = Type.Object({
  id: Type.String({ format: 'uuid' }),
  role: Type.Union([Type.Literal('resident'), Type.Literal('manager'), Type.Literal('front_desk')]),
  status: Type.Union(
    [Type.Literal('pending'), Type.Literal('approved'), Type.Literal('rejected')],
    { description: 'pending/rejected: o app mostra a tela de espera ou de correção (req. 15, 18)' },
  ),
  can_list_spots: Type.Boolean({ description: 'Pode anunciar vagas (req. 17)' }),
  unit_relation: Nullable(Type.Union([Type.Literal('owner'), Type.Literal('tenant')])),
  rejection_reason: Nullable(Type.String({ description: 'Motivo, quando recusado (req. 18)' })),
  condominium: Type.Object({
    id: Type.String({ format: 'uuid' }),
    name: Type.String(),
    timezone: Type.String({ examples: ['America/Sao_Paulo'] }),
  }),
  unit: Nullable(
    Type.Object({
      id: Type.String({ format: 'uuid' }),
      number: Type.String(),
      block: Type.Object({ id: Type.String({ format: 'uuid' }), name: Type.String() }),
    }),
  ),
});

export const Me = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  email: Type.String(),
  phone: Nullable(Type.String()),
  is_admin: Type.Boolean(),
  memberships: Type.Array(MyMembership, {
    description: 'Vínculos atuais; removidos não aparecem. Portaria não tem unidade.',
  }),
});
export type Me = Static<typeof Me>;
