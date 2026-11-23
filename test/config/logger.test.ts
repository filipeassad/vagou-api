import { describe, expect, it } from 'vitest';
import { buildTestApp, captureLogs } from '../helper.ts';

describe('logger', () => {
  it('esconde credenciais e dados pessoais (princípio VI)', async () => {
    const logs = captureLogs();
    const app = await buildTestApp({ config: { LOG_LEVEL: 'info' }, logStream: logs.stream });

    app.log.info(
      {
        req: { headers: { authorization: 'Bearer token-secreto', cookie: 'refresh=abc123' } },
        password: 'minha-senha',
        user: { email: 'maria@example.com', phone: '67999990000', name: 'Maria' },
        refreshToken: 'refresh-secreto',
      },
      'evento de teste',
    );
    await app.close();

    const output = logs.text();
    expect(output).toContain('evento de teste');
    expect(output).toContain('[Redacted]');
    expect(output).toContain('Maria');
    for (const secret of [
      'token-secreto',
      'abc123',
      'minha-senha',
      'maria@example.com',
      '67999990000',
      'refresh-secreto',
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
