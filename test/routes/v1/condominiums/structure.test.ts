import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCondominium, createMember, signIn } from '../../../fixtures.ts';
import { buildTestApp } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

type Condo = Awaited<ReturnType<typeof createCondominium>>;

/** Spec 001, req. 2, 3 e 13: o síndico mantém dados, blocos, unidades e configurações. */
describe('síndico mantém o condomínio', () => {
  let app: FastifyInstance;
  let condo: Condo;
  let manager: Record<string, string>;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    condo = await createCondominium(app);
    const member = await createMember(app, condo, { role: 'manager' });
    manager = (await signIn(app, member.user.id)).headers;
  });

  function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    payload?: Record<string, unknown>,
    headers = manager,
  ) {
    return app.inject({ method, url: `/v1/condominiums/${condo.id}${path}`, payload, headers });
  }

  describe('dados e configurações', () => {
    it('salva nome, endereço, validade do convite e regra de inquilinos', async () => {
      const res = await call('PATCH', '', {
        name: 'Residencial Aurora',
        address: 'Rua Nova, 200',
        invite_validity_days: 15,
        tenants_can_list_spots: false,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: 'Residencial Aurora',
        address: 'Rua Nova, 200',
        invite_validity_days: 15,
        tenants_can_list_spots: false,
      });
      const saved = await call('GET', '');
      expect(saved.json()).toMatchObject({ name: 'Residencial Aurora', invite_validity_days: 15 });
    });

    it('só o que foi enviado muda', async () => {
      const before = (await call('GET', '')).json();

      const res = await call('PATCH', '', { invite_validity_days: 30 });

      expect(res.json()).toEqual({ ...before, invite_validity_days: 30 });
    });

    it('desligar inquilinos tira a permissão de anunciar dos inquilinos já aprovados', async () => {
      const tenant = await createMember(app, condo);
      const owner = await createMember(app, condo);
      await app.db
        .updateTable('memberships')
        .set({ can_list_spots: true })
        .where('id', 'in', [tenant.membershipId, owner.membershipId])
        .execute();
      await app.db
        .updateTable('memberships')
        .set({ unit_relation: 'tenant' })
        .where('id', '=', tenant.membershipId)
        .execute();

      await call('PATCH', '', { tenants_can_list_spots: false });

      const rows = await app.db
        .selectFrom('memberships')
        .select(['id', 'can_list_spots'])
        .where('id', 'in', [tenant.membershipId, owner.membershipId])
        .execute();
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.can_list_spots]));
      expect(byId[tenant.membershipId]).toBe(false);
      expect(byId[owner.membershipId]).toBe(true);
    });

    it('validade do convite fora de 1 a 90 dias, fuso inválido e corpo vazio são recusados', async () => {
      expect((await call('PATCH', '', { invite_validity_days: 0 })).statusCode).toBe(400);
      expect((await call('PATCH', '', { invite_validity_days: 91 })).statusCode).toBe(400);
      const tz = await call('PATCH', '', { timezone: 'Marte/Olympus' });
      expect(tz.json().error.code).toBe('INVALID_TIMEZONE');
      expect((await call('PATCH', '', {})).statusCode).toBe(400);
    });

    it('morador e portaria não alteram', async () => {
      const resident = await createMember(app, condo);
      const frontDesk = await createMember(app, condo, { role: 'front_desk' });

      for (const member of [resident, frontDesk]) {
        const headers = (await signIn(app, member.user.id)).headers;
        const res = await call('PATCH', '', { name: 'Invadido' }, headers);
        expect(res.statusCode).toBe(403);
      }
    });
  });

  describe('blocos', () => {
    it('cria, lista em ordem natural, renomeia e apaga bloco vazio', async () => {
      const b10 = (await call('POST', '/blocks', { name: 'Bloco 10' })).json();
      const created = await call('POST', '/blocks', { name: '  Bloco 2 ' });
      expect(created.statusCode).toBe(201);
      expect(created.json().name).toBe('Bloco 2');

      const list = (await call('GET', '/blocks')).json().items.map((b: { name: string }) => b.name);
      expect(list).toEqual(['Bloco 2', 'Bloco 10', 'Bloco A']);

      const renamed = await call('PATCH', `/blocks/${b10.id}`, { name: 'Torre Norte' });
      expect(renamed.json()).toEqual({ id: b10.id, name: 'Torre Norte' });

      expect((await call('DELETE', `/blocks/${b10.id}`)).statusCode).toBe(204);
      expect((await call('GET', '/blocks')).json().items).toHaveLength(2);
    });

    it('nome repetido no condomínio → 409; o mesmo nome em outro condomínio pode', async () => {
      const dup = await call('POST', '/blocks', { name: 'Bloco A' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('BLOCK_NAME_TAKEN');

      const other = await createCondominium(app);
      const otherManager = await createMember(app, other, { role: 'manager' });
      const res = await app.inject({
        method: 'POST',
        url: `/v1/condominiums/${other.id}/blocks`,
        payload: { name: 'Torre Sul' },
        headers: (await signIn(app, otherManager.user.id)).headers,
      });
      expect(res.statusCode).toBe(201);
    });

    it('bloco com unidades não pode ser apagado', async () => {
      const res = await call('DELETE', `/blocks/${condo.blockId}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('BLOCK_NOT_EMPTY');
    });
  });

  describe('unidades', () => {
    it('cria, corrige o número, move de bloco e lista dentro do bloco', async () => {
      const torre = (await call('POST', '/blocks', { name: 'Torre B' })).json();
      const created = await call('POST', '/units', { block_id: condo.blockId, number: '102' });
      expect(created.statusCode).toBe(201);
      const unit = created.json();

      const fixed = await call('PATCH', `/units/${unit.id}`, { number: '103' });
      expect(fixed.json()).toEqual({ id: unit.id, block_id: condo.blockId, number: '103' });

      const moved = await call('PATCH', `/units/${unit.id}`, { block_id: torre.id });
      expect(moved.json().block_id).toBe(torre.id);

      const items = (await call('GET', '/blocks')).json().items;
      expect(items.find((b: { id: string }) => b.id === torre.id).units).toEqual([
        { id: unit.id, number: '103' },
      ]);
    });

    it('unidades em ordem natural: 2, 10, 101', async () => {
      for (const number of ['10', '2']) {
        await call('POST', '/units', { block_id: condo.blockId, number });
      }
      const units = (await call('GET', '/blocks')).json().items[0].units;
      expect(units.map((u: { number: string }) => u.number)).toEqual(['2', '10', '101']);
    });

    it('número repetido no mesmo bloco → 409 (criar e renomear); em outro bloco pode', async () => {
      const dup = await call('POST', '/units', { block_id: condo.blockId, number: '101' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('UNIT_NUMBER_TAKEN');

      const other = (
        await call('POST', '/units', { block_id: condo.blockId, number: '102' })
      ).json();
      const rename = await call('PATCH', `/units/${other.id}`, { number: '101' });
      expect(rename.json().error.code).toBe('UNIT_NUMBER_TAKEN');

      const torre = (await call('POST', '/blocks', { name: 'Torre B' })).json();
      const sameNumber = await call('POST', '/units', { block_id: torre.id, number: '101' });
      expect(sameNumber.statusCode).toBe(201);
    });

    it('unidade nunca usada pode ser apagada', async () => {
      const unit = (
        await call('POST', '/units', { block_id: condo.blockId, number: '202' })
      ).json();
      expect((await call('DELETE', `/units/${unit.id}`)).statusCode).toBe(204);
    });

    it('unidade com morador aprovado ou pendente não pode ser apagada', async () => {
      await createMember(app, condo, { status: 'pending' });

      const res = await call('DELETE', `/units/${condo.unitId}`);

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('UNIT_HAS_RESIDENTS');
    });

    it('unidade que já teve morador (removido) ou convite não pode ser apagada', async () => {
      const newUnit = async (number: string) =>
        (await call('POST', '/units', { block_id: condo.blockId, number })).json().id as string;
      const formerHome = await newUnit('201');
      const invited = await newUnit('202');
      const { user } = await createMember(app, await createCondominium(app));
      await app.db
        .insertInto('memberships')
        .values({
          user_id: user.id,
          condominium_id: condo.id,
          unit_id: formerHome,
          unit_relation: 'owner',
          role: 'resident',
          status: 'removed',
          origin: 'admin',
        })
        .execute();
      await app.db
        .insertInto('invites')
        .values({
          condominium_id: condo.id,
          unit_id: invited,
          token_hash: Buffer.from('convite-de-teste'),
          unit_relation: 'owner',
          created_by: user.id,
          expires_at: new Date(Date.now() + 86_400_000),
        })
        .execute();

      for (const unitId of [formerHome, invited]) {
        const res = await call('DELETE', `/units/${unitId}`);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('UNIT_HAS_HISTORY');
      }
    });
  });

  describe('isolamento (princípio I)', () => {
    it('bloco e unidade de outro condomínio respondem 404 e não mudam', async () => {
      const other = await createCondominium(app);

      const renameBlock = await call('PATCH', `/blocks/${other.blockId}`, { name: 'Hack' });
      const deleteBlock = await call('DELETE', `/blocks/${other.blockId}`);
      const editUnit = await call('PATCH', `/units/${other.unitId}`, { number: '999' });
      const deleteUnit = await call('DELETE', `/units/${other.unitId}`);
      const unitInForeignBlock = await call('POST', '/units', {
        block_id: other.blockId,
        number: '1',
      });
      const moveToForeignBlock = await call('PATCH', `/units/${condo.unitId}`, {
        block_id: other.blockId,
      });

      expect(renameBlock.json().error.code).toBe('BLOCK_NOT_FOUND');
      expect(deleteBlock.json().error.code).toBe('BLOCK_NOT_FOUND');
      expect(editUnit.json().error.code).toBe('UNIT_NOT_FOUND');
      expect(deleteUnit.json().error.code).toBe('UNIT_NOT_FOUND');
      expect(unitInForeignBlock.json().error.code).toBe('BLOCK_NOT_FOUND');
      expect(moveToForeignBlock.json().error.code).toBe('BLOCK_NOT_FOUND');
      const untouched = await app.db
        .selectFrom('units')
        .innerJoin('blocks', 'blocks.id', 'units.block_id')
        .select(['units.number', 'blocks.name'])
        .where('units.id', '=', other.unitId)
        .executeTakeFirstOrThrow();
      expect(untouched).toEqual({ number: '101', name: 'Bloco A' });
    });

    it('a lista de blocos só traz os do próprio condomínio', async () => {
      await createCondominium(app);
      const items = (await call('GET', '/blocks')).json().items;
      expect(items).toEqual([
        { id: condo.blockId, name: 'Bloco A', units: [{ id: condo.unitId, number: '101' }] },
      ]);
    });

    it('morador não vê nem altera blocos e unidades', async () => {
      const resident = await createMember(app, condo);
      const headers = (await signIn(app, resident.user.id)).headers;
      expect((await call('GET', '/blocks', undefined, headers)).statusCode).toBe(403);
      expect((await call('POST', '/blocks', { name: 'X' }, headers)).statusCode).toBe(403);
      expect(
        (await call('POST', '/units', { block_id: condo.blockId, number: '9' }, headers))
          .statusCode,
      ).toBe(403);
    });
  });
});
