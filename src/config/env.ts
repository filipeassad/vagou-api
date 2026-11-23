import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const ConfigSchema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    { default: 'development' },
  ),
  HOST: Type.String({ default: '0.0.0.0' }),
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3333 }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
      Type.Literal('silent'),
    ],
    { default: 'info' },
  ),
  DATABASE_URL: Type.String({ minLength: 1 }),
  // Assina os access tokens (D5). Mínimo de 32 caracteres para HS256.
  JWT_SECRET: Type.String({ minLength: 32 }),
  WEB_ORIGIN: Type.String({ minLength: 1, default: 'http://localhost:5173' }),
  // Notificador (D9): console (desenvolvimento), memory (testes), email (produção).
  NOTIFIER: Type.Union([Type.Literal('console'), Type.Literal('memory'), Type.Literal('email')], {
    default: 'console',
  }),
  // Remetente dos e-mails, ex.: "Vagou <nao-responda@vagou.com.br>". Exigido com NOTIFIER=email.
  EMAIL_FROM: Type.Optional(Type.String({ minLength: 3 })),
});

export type Config = Static<typeof ConfigSchema>;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Configuração inválida:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type SchemaError = {
  keyword: string;
  instancePath: string;
  params: { requiredProperties?: string[] };
  message?: string;
};

/**
 * Lê e valida a configuração a partir das variáveis de ambiente (D14).
 * As mensagens de erro citam só o NOME da variável, nunca o valor,
 * para não vazar segredos (princípio VI).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const input: Record<string, unknown> = {};
  for (const key of Object.keys(ConfigSchema.properties)) {
    const value = env[key];
    if (value !== undefined && value !== '') input[key] = value;
  }

  const withDefaults = Value.Default(ConfigSchema, input);
  const converted = Value.Convert(ConfigSchema, withDefaults);

  if (Value.Check(ConfigSchema, converted)) {
    const problems = crossFieldProblems(converted);
    if (problems.length > 0) throw new ConfigError(problems);
    return converted;
  }

  const problems = new Set<string>();
  for (const error of Value.Errors(ConfigSchema, converted) as SchemaError[]) {
    if (error.keyword === 'required') {
      for (const name of error.params.requiredProperties ?? []) {
        problems.add(`${name} é obrigatória e não foi definida`);
      }
    } else {
      const name = error.instancePath.replace(/^\//, '').split('/')[0] || '(raiz)';
      problems.add(`${name} é inválida: ${error.message ?? error.keyword}`);
    }
  }
  throw new ConfigError([...problems]);
}

/** Regras que envolvem mais de uma variável. */
function crossFieldProblems(config: Config): string[] {
  const problems: string[] = [];
  // Em produção a notificação precisa chegar de verdade (o console só imprime o link).
  if (config.NODE_ENV === 'production' && config.NOTIFIER !== 'email') {
    problems.push('NOTIFIER é inválida: em produção deve ser "email"');
  }
  if (config.NOTIFIER === 'email' && !config.EMAIL_FROM) {
    problems.push('EMAIL_FROM é obrigatória quando NOTIFIER=email');
  }
  return problems;
}
