import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/plugins/external/db.ts';
import { resetDatabase, TEST_DATABASE_URL } from '../test-database.ts';

// Regras que o próprio banco garante (plano 001, seção 3), mesmo que a aplicação erre.
const db = createDb(TEST_DATABASE_URL);

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await resetDatabase(db);
});

let sequence = 0;

async function createUser(email = `pessoa${++sequence}@example.com`) {
  return db
    .insertInto('users')
    .values({ name: 'Pessoa', email, phone: '67999990000' })
    .returning('id')
    .executeTakeFirstOrThrow();
}

async function createCondominium() {
  const condominium = await db
    .insertInto('condominiums')
    .values({ name: 'Residencial', address: 'Rua A, 1', public_code: `cod-${++sequence}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const block = await db
    .insertInto('blocks')
    .values({ condominium_id: condominium.id, name: 'Bloco A' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const unit = await db
    .insertInto('units')
    .values({ condominium_id: condominium.id, block_id: block.id, number: '101' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: condominium.id, blockId: block.id, unitId: unit.id };
}

type MembershipInput = {
  userId: string;
  condominiumId: string;
  unitId?: string | null;
  role?: 'resident' | 'manager' | 'front_desk';
  status?: 'pending' | 'approved' | 'rejected' | 'removed';
};

function insertMembership({
  userId,
  condominiumId,
  unitId = null,
  role = 'resident',
  status = 'approved',
}: MembershipInput) {
  return db
    .insertInto('memberships')
    .values({
      user_id: userId,
      condominium_id: condominiumId,
      unit_id: unitId,
      unit_relation: unitId ? 'owner' : null,
      role,
      status,
      origin: 'admin',
    })
    .execute();
}

describe('modelo de dados da spec 001', () => {
  it('recusa dois síndicos aprovados no mesmo condomínio', async () => {
    const condominium = await createCondominium();
    const first = await createUser();
    const second = await createUser();

    await insertMembership({ userId: first.id, condominiumId: condominium.id, role: 'manager' });

    await expect(
      insertMembership({ userId: second.id, condominiumId: condominium.id, role: 'manager' }),
    ).rejects.toThrow(/memberships_one_manager/);
  });

  it('aceita síndicos em condomínios diferentes', async () => {
    const a = await createCondominium();
    const b = await createCondominium();
    const user = await createUser();
    const other = await createUser();

    await insertMembership({ userId: user.id, condominiumId: a.id, role: 'manager' });
    await expect(
      insertMembership({ userId: other.id, condominiumId: b.id, role: 'manager' }),
    ).resolves.toBeDefined();
  });

  it('recusa duas portarias aprovadas no mesmo condomínio', async () => {
    const condominium = await createCondominium();
    const first = await createUser();
    const second = await createUser();

    await insertMembership({ userId: first.id, condominiumId: condominium.id, role: 'front_desk' });

    await expect(
      insertMembership({ userId: second.id, condominiumId: condominium.id, role: 'front_desk' }),
    ).rejects.toThrow(/memberships_one_front_desk/);
  });

  it('permite só um vínculo ativo por usuário no condomínio; após remover, aceita outro', async () => {
    const condominium = await createCondominium();
    const user = await createUser();
    const base = { userId: user.id, condominiumId: condominium.id, unitId: condominium.unitId };

    await insertMembership({ ...base, status: 'pending' });
    await expect(insertMembership(base)).rejects.toThrow(/memberships_one_active_per_user/);

    await db.updateTable('memberships').set({ status: 'removed' }).execute();
    await expect(insertMembership(base)).resolves.toBeDefined();
  });

  it('recusa vínculo com unidade de outro condomínio', async () => {
    const a = await createCondominium();
    const b = await createCondominium();
    const user = await createUser();

    await expect(
      insertMembership({ userId: user.id, condominiumId: a.id, unitId: b.unitId }),
    ).rejects.toThrow(/foreign key/);
  });

  it('recusa unidade apontando para bloco de outro condomínio', async () => {
    const a = await createCondominium();
    const b = await createCondominium();

    await expect(
      db
        .insertInto('units')
        .values({ condominium_id: a.id, block_id: b.blockId, number: '202' })
        .execute(),
    ).rejects.toThrow(/foreign key/);
  });

  it('exige unidade para morador e proíbe unidade para a portaria', async () => {
    const condominium = await createCondominium();
    const resident = await createUser();
    const frontDesk = await createUser();

    await expect(
      insertMembership({ userId: resident.id, condominiumId: condominium.id, unitId: null }),
    ).rejects.toThrow(/memberships_resident_has_unit/);
    await expect(
      insertMembership({
        userId: frontDesk.id,
        condominiumId: condominium.id,
        unitId: condominium.unitId,
        role: 'front_desk',
      }),
    ).rejects.toThrow(/memberships_front_desk_has_no_unit/);
  });

  it('recusa e-mail repetido mesmo com maiúsculas diferentes (req. 23)', async () => {
    await createUser('Maria@Example.com');

    await expect(createUser('maria@example.COM')).rejects.toThrow(/users_email_key/);
  });

  it('recusa unidade repetida no mesmo bloco', async () => {
    const condominium = await createCondominium();

    await expect(
      db
        .insertInto('units')
        .values({ condominium_id: condominium.id, block_id: condominium.blockId, number: '101' })
        .execute(),
    ).rejects.toThrow(/units_block_id_number_key/);
  });
});
