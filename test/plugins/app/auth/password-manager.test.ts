import { describe, expect, it } from 'vitest';
import { createPasswordManager } from '../../../../src/plugins/app/auth/password-manager.ts';

describe('passwordManager (Argon2id)', () => {
  const passwords = createPasswordManager();

  it('valida a senha correta e recusa a errada', async () => {
    const hash = await passwords.hash('senha-forte-123');

    expect(await passwords.verify(hash, 'senha-forte-123')).toBe(true);
    expect(await passwords.verify(hash, 'senha-forte-124')).toBe(false);
    expect(await passwords.verify(hash, 'SENHA-FORTE-123')).toBe(false);
  });

  it('gera hash Argon2id diferente da senha e diferente a cada vez (salt)', async () => {
    const first = await passwords.hash('senha-forte-123');
    const second = await passwords.hash('senha-forte-123');

    expect(first).not.toContain('senha-forte-123');
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(first).not.toBe(second);
  });

  it('trata hash inválido como senha errada, sem lançar erro', async () => {
    expect(await passwords.verify('isso-nao-e-um-hash', 'qualquer')).toBe(false);
  });
});
