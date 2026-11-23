import { Type, type Static } from 'typebox';
import { Email, NewPassword } from './auth.ts';

export const FrontDeskBody = Type.Object(
  { email: Email, password: NewPassword },
  { additionalProperties: false },
);
export type FrontDeskBody = Static<typeof FrontDeskBody>;

/** A senha nunca volta: o síndico vê só o e-mail de login da portaria. */
export const FrontDeskAccess = Type.Object({
  email: Type.Union([Type.String(), Type.Null()], {
    description: 'E-mail de login da portaria; null se o acesso ainda não foi criado.',
  }),
});
