import { Type, type Static } from 'typebox';

export const Email = Type.String({
  format: 'email',
  maxLength: 254,
  examples: ['maria@email.com'],
});

/**
 * Senha nova (cadastro, convite, redefinição): 8 a 128 caracteres, sem exigir símbolo
 * ou maiúscula (recomendação do NIST SP 800-63B).
 */
export const NewPassword = Type.String({
  minLength: 8,
  maxLength: 128,
  description: 'De 8 a 128 caracteres.',
});

export const LoginBody = Type.Object({
  email: Email,
  // No login não aplicamos a regra de senha nova: só o limite de tamanho.
  password: Type.String({ minLength: 1, maxLength: 128 }),
  client: Type.Optional(
    Type.Union([Type.Literal('web'), Type.Literal('mobile')], {
      default: 'web',
      description:
        'web: refresh token vai no cookie HttpOnly (Path=/v1/auth). mobile: refresh token vai no corpo da resposta.',
    }),
  ),
});
export type LoginBody = Static<typeof LoginBody>;

/** refresh e logout: o mobile manda o token no corpo; o web manda sem corpo (cookie). */
export const RefreshBody = Type.Object({
  refresh_token: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});
export type RefreshBody = Static<typeof RefreshBody>;

export const TokenResponse = Type.Object({
  access_token: Type.String({ description: 'JWT para o header Authorization: Bearer' }),
  token_type: Type.Literal('Bearer'),
  expires_in: Type.Integer({ description: 'Validade do access token, em segundos' }),
  refresh_token: Type.Optional(
    Type.String({ description: 'Só para client = mobile. No web, vai no cookie.' }),
  ),
});
export type TokenResponse = Static<typeof TokenResponse>;

export const ForgotPasswordBody = Type.Object({ email: Email });
export type ForgotPasswordBody = Static<typeof ForgotPasswordBody>;

export const ResetPasswordBody = Type.Object({
  token: Type.String({
    minLength: 1,
    maxLength: 200,
    description: 'Vem no fragmento do link do e-mail: /redefinir-senha#token=...',
  }),
  password: NewPassword,
});
export type ResetPasswordBody = Static<typeof ResetPasswordBody>;
