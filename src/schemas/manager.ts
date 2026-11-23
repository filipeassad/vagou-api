import { Type } from 'typebox';
import { Email } from './auth.ts';

const Uuid = Type.String({ format: 'uuid' });

/** Síndico escolhe o novo síndico na lista de moradores (pelo id do vínculo). */
export const TransferManagerBody = Type.Object(
  { membership_id: Uuid },
  { additionalProperties: false },
);

/** O admin não vê a lista de moradores: indica o novo síndico pelo e-mail da conta. */
export const AdminTransferManagerBody = Type.Object(
  { email: Email },
  { additionalProperties: false },
);

export const ManagerTransfer = Type.Object({
  manager: Type.Object({ user_id: Uuid, name: Type.String(), email: Type.String() }),
  previous_manager: Type.Union([
    Type.Object({
      user_id: Uuid,
      name: Type.String(),
      became: Type.Union([Type.Literal('resident'), Type.Literal('removed')], {
        description:
          'resident: continua como morador da unidade dele. removed: não tinha unidade e perdeu o vínculo.',
      }),
    }),
    Type.Null(),
  ]),
});
