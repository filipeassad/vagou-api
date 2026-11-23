import { Type, type Static } from 'typebox';
import { Email } from './auth.ts';
import { DateTime } from './common.ts';

const Name = Type.String({ minLength: 1, maxLength: 120 });

export const CreateCondominiumBody = Type.Object({
  name: Name,
  address: Type.String({ minLength: 1, maxLength: 300 }),
  timezone: Type.Optional(
    Type.String({
      default: 'America/Sao_Paulo',
      description: 'Fuso IANA usado para exibir horários (restrições técnicas)',
    }),
  ),
  manager: Type.Object({
    name: Name,
    email: Email,
    phone: Type.Optional(Type.String({ minLength: 8, maxLength: 20 })),
  }),
});
export type CreateCondominiumBody = Static<typeof CreateCondominiumBody>;

export const AdminCondominium = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  address: Type.String(),
  public_code: Type.String({ description: 'Código do link do QR Code de cadastro (req. 6)' }),
  timezone: Type.String(),
  created_at: DateTime,
  manager: Type.Union([
    Type.Object({
      id: Type.String({ format: 'uuid' }),
      name: Type.String(),
      email: Type.String(),
    }),
    Type.Null(),
  ]),
});

export const AdminCondominiumList = Type.Object({ items: Type.Array(AdminCondominium) });
