import { Type, type Static } from 'typebox';

/** `:cid` das rotas /v1/condominiums/:cid/*. */
export const CondominiumParams = Type.Object({
  cid: Type.String({ format: 'uuid', description: 'id do condomínio' }),
});
export type CondominiumParams = Static<typeof CondominiumParams>;

export const Condominium = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  address: Type.String(),
  tenants_can_list_spots: Type.Boolean({
    description: 'Inquilinos podem receber permissão para anunciar vagas (req. 3)',
  }),
  invite_validity_days: Type.Integer({ description: 'Validade dos convites, em dias (req. 13)' }),
  timezone: Type.String({ examples: ['America/Sao_Paulo'] }),
});
export type Condominium = Static<typeof Condominium>;

/** PATCH /v1/condominiums/:cid: só os campos enviados mudam. */
export const CondominiumPatch = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    address: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    timezone: Type.Optional(Type.String({ description: 'Fuso IANA, ex.: America/Sao_Paulo' })),
    tenants_can_list_spots: Type.Optional(
      Type.Boolean({
        description:
          'false também tira a permissão de anunciar de todos os inquilinos já aprovados (req. 3)',
      }),
    ),
    invite_validity_days: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 90, description: 'Padrão 7 (req. 13)' }),
    ),
  },
  { minProperties: 1, additionalProperties: false },
);
export type CondominiumPatch = Static<typeof CondominiumPatch>;

const BlockName = Type.String({ minLength: 1, maxLength: 60, examples: ['Bloco A', 'Torre 2'] });
const UnitNumber = Type.String({ minLength: 1, maxLength: 20, examples: ['101', 'Casa 3'] });

export const BlockParams = Type.Object({
  cid: Type.String({ format: 'uuid' }),
  blockId: Type.String({ format: 'uuid' }),
});

export const UnitParams = Type.Object({
  cid: Type.String({ format: 'uuid' }),
  unitId: Type.String({ format: 'uuid' }),
});

export const BlockBody = Type.Object({ name: BlockName }, { additionalProperties: false });

export const Block = Type.Object({ id: Type.String({ format: 'uuid' }), name: Type.String() });

export const BlockList = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Type.String({ format: 'uuid' }),
      name: Type.String(),
      units: Type.Array(
        Type.Object({ id: Type.String({ format: 'uuid' }), number: Type.String() }),
      ),
    }),
    { description: 'Blocos e unidades em ordem natural ("2" antes de "10")' },
  ),
});

export const UnitCreateBody = Type.Object(
  { block_id: Type.String({ format: 'uuid' }), number: UnitNumber },
  { additionalProperties: false },
);

export const UnitPatchBody = Type.Object(
  {
    block_id: Type.Optional(Type.String({ format: 'uuid', description: 'Mover para outro bloco' })),
    number: Type.Optional(UnitNumber),
  },
  { minProperties: 1, additionalProperties: false },
);

export const Unit = Type.Object({
  id: Type.String({ format: 'uuid' }),
  block_id: Type.String({ format: 'uuid' }),
  number: Type.String(),
});
