import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.ts';

const validEnv = {
  DATABASE_URL: 'postgres://vagou:vagou@localhost:5432/vagou',
  JWT_SECRET: 'a'.repeat(32),
};

describe('loadConfig', () => {
  it('aplica os valores padrão e converte tipos', () => {
    const config = loadConfig({ ...validEnv, PORT: '8080' });

    expect(config.PORT).toBe(8080);
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('lista todas as variáveis obrigatórias que faltam', () => {
    let error: unknown;
    try {
      loadConfig({});
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain('DATABASE_URL é obrigatória');
    expect(message).toContain('JWT_SECRET é obrigatória');
  });

  it('trata variável vazia como não definida', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: '' })).toThrow(
      'DATABASE_URL é obrigatória',
    );
  });

  it('recusa JWT_SECRET curto sem mostrar o valor', () => {
    const shortSecret = 'segredo-curto';
    let message = '';
    try {
      loadConfig({ ...validEnv, JWT_SECRET: shortSecret });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('JWT_SECRET é inválida');
    expect(message).not.toContain(shortSecret);
  });

  it('recusa valores fora do permitido', () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'staging' })).toThrow('NODE_ENV é inválida');
    expect(() => loadConfig({ ...validEnv, PORT: 'abc' })).toThrow('PORT é inválida');
  });

  it('notificador: console por padrão; produção exige email com remetente', () => {
    expect(loadConfig(validEnv).NOTIFIER).toBe('console');
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'production' })).toThrow(
      'NOTIFIER é inválida: em produção deve ser "email"',
    );
    expect(() => loadConfig({ ...validEnv, NOTIFIER: 'email' })).toThrow(
      'EMAIL_FROM é obrigatória quando NOTIFIER=email',
    );
    const production = loadConfig({
      ...validEnv,
      NODE_ENV: 'production',
      NOTIFIER: 'email',
      EMAIL_FROM: 'Vagou <nao-responda@vagou.com.br>',
    });
    expect(production.NOTIFIER).toBe('email');
  });
});
