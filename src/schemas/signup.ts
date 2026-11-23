import { Type, type Static } from 'typebox';
import { Email, NewPassword } from './auth.ts';

const Uuid = Type.String({ format: 'uuid' });

/** `:code` do link/QR Code do condomínio (req. 6). */
export const PublicCodeParams = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 32, description: 'Código do QR Code' }),
});

export const PublicCondominium = Type.Object({
  name: Type.String(),
  blocks: Type.Array(
    Type.Object({
      id: Uuid,
      name: Type.String(),
      units: Type.Array(Type.Object({ id: Uuid, number: Type.String() })),
    }),
    { description: 'Só os blocos e unidades cadastrados neste condomínio (req. 8)' },
  ),
});

const UnitRelation = Type.Union([Type.Literal('owner'), Type.Literal('tenant')], {
  description: 'owner: proprietário; tenant: inquilino',
});

/** Escolha da unidade, igual no cadastro novo e no de quem já tem conta. */
const UnitChoiceFields = {
  unit_id: Uuid,
  unit_relation: UnitRelation,
};

/** Dados da conta nova: iguais no cadastro pelo QR Code e no aceite de convite. */
export const NewAccountFields = {
  name: Type.String({ minLength: 2, maxLength: 100 }),
  email: Email,
  phone: Type.String({
    pattern: '^[0-9()+\\- ]{8,20}$',
    description: 'Telefone com DDD. Guardado só com os dígitos.',
    examples: ['(67) 99999-0000'],
  }),
  password: NewPassword,
};

export const SignupBody = Type.Object(
  { ...NewAccountFields, ...UnitChoiceFields },
  { additionalProperties: false },
);
export type SignupBody = Static<typeof SignupBody>;

export const JoinBody = Type.Object(
  { public_code: PublicCodeParams.properties.code, ...UnitChoiceFields },
  { additionalProperties: false },
);
export type JoinBody = Static<typeof JoinBody>;

export const PendingMembership = Type.Object({
  membership_id: Uuid,
  status: Type.Literal('pending', {
    description: 'Aguardando o síndico. O app mostra a tela de espera (req. 9, 15).',
  }),
});
