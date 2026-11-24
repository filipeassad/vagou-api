import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCondominium, createMember, createUser, signIn } from '../../../fixtures.ts';
import { buildTestApp, sentNotifications } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

type Condo = Awaited<ReturnType<typeof createCondominium>>;
type Member = Awaited<ReturnType<typeof createMember>>;

/** Spec 001, req. 5 e cenário "troca de síndico". */
describe('troca de síndico', () => {
  let app: FastifyInstance;
  let condo: Condo;
  let maria: Member;
  let joao: Member;
  let mariaHeaders: Record<string, string>;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    sentNotifications(app).length = 0;
    condo = await createCondominium(app);
    maria = await createMember(app, condo, { role: 'manager' });
    joao = await createMember(app, condo);
    mariaHeaders = (await signIn(app, maria.user.id)).headers;
  });

  function transfer(membershipId: string, headers = mariaHeaders, cid = condo.id) {
    return app.inject({
      method: 'POST',
      url: `/v1/condominiums/${cid}/manager`,
      payload: { membership_id: membershipId },
      headers,
    });
  }

  async function asAdmin() {
    const admin = await createUser(app);
    await app.db.updateTable('users').set({ is_admin: true }).where('id', '=', admin.id).execute();
    return (await signIn(app, admin.id)).headers;
  }

  function adminTransfer(email: string, headers: Record<string, string>, cid = condo.id) {
    return app.inject({
      method: 'POST',
      url: `/v1/admin/condominiums/${cid}/manager`,
      payload: { email },
      headers,
    });
  }

  async function roles(cid = condo.id) {
    const rows = await app.db
      .selectFrom('memberships')
      .select(['user_id', 'role', 'status'])
      .where('condominium_id', '=', cid)
      .execute();
    return Object.fromEntries(rows.map((r) => [r.user_id, `${r.role}/${r.status}`]));
  }

  const blocksUrl = () => `/v1/condominiums/${condo.id}/blocks`;

  it('síndica passa o papel: João vira síndico e Maria continua moradora, sem permissões', async () => {
    const res = await transfer(joao.membershipId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      manager: { user_id: joao.user.id, name: joao.user.name, email: joao.user.email },
      previous_manager: { user_id: maria.user.id, name: maria.user.name, became: 'resident' },
    });
    expect(await roles()).toEqual({
      [maria.user.id]: 'resident/approved',
      [joao.user.id]: 'manager/approved',
    });

    // Maria perde as permissões na hora, com o mesmo token; continua vendo o condomínio.
    expect((await app.inject({ url: blocksUrl(), headers: mariaHeaders })).statusCode).toBe(403);
    const asMaria = await app.inject({
      url: `/v1/condominiums/${condo.id}`,
      headers: mariaHeaders,
    });
    expect(asMaria.statusCode).toBe(200);
    const joaoHeaders = (await signIn(app, joao.user.id)).headers;
    expect((await app.inject({ url: blocksUrl(), headers: joaoHeaders })).statusCode).toBe(200);

    expect(sentNotifications(app)).toMatchObject([
      { type: 'manager_role_received', to: { email: joao.user.email } },
    ]);
  });

  it('admin passa o papel pelo e-mail do morador', async () => {
    const res = await adminTransfer(joao.user.email.toUpperCase(), await asAdmin());

    expect(res.statusCode).toBe(200);
    expect(res.json().previous_manager.became).toBe('resident');
    expect(await roles()).toEqual({
      [maria.user.id]: 'resident/approved',
      [joao.user.id]: 'manager/approved',
    });
  });

  it('admin define síndico quando não há nenhum', async () => {
    await app.db.deleteFrom('memberships').where('id', '=', maria.membershipId).execute();

    const res = await adminTransfer(joao.user.email, await asAdmin());

    expect(res.statusCode).toBe(200);
    expect(res.json().previous_manager).toBeNull();
    expect((await roles())[joao.user.id]).toBe('manager/approved');
  });

  it('síndico sem unidade (cadastrado pelo admin) perde o vínculo ao passar o papel', async () => {
    await app.db
      .updateTable('memberships')
      .set({ unit_id: null, unit_relation: null })
      .where('id', '=', maria.membershipId)
      .execute();

    const res = await transfer(joao.membershipId);

    expect(res.json().previous_manager.became).toBe('removed');
    expect((await roles())[maria.user.id]).toBe('manager/removed');
    expect((await app.inject({ url: blocksUrl(), headers: mariaHeaders })).statusCode).toBe(404);
  });

  it('só morador aprovado pode receber o papel', async () => {
    const pending = await createMember(app, condo, { status: 'pending' });
    const frontDesk = await createMember(app, condo, { role: 'front_desk' });

    for (const target of [pending, frontDesk, maria]) {
      const res = await transfer(target.membershipId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('NOT_APPROVED_RESIDENT');
    }
    expect((await roles())[maria.user.id]).toBe('manager/approved');
  });

  it('morador e portaria não passam o papel; morador de outro condomínio não recebe', async () => {
    const frontDesk = await createMember(app, condo, { role: 'front_desk' });
    for (const member of [joao, frontDesk]) {
      const headers = (await signIn(app, member.user.id)).headers;
      expect((await transfer(joao.membershipId, headers)).statusCode).toBe(403);
    }

    const other = await createCondominium(app);
    const outsider = await createMember(app, other);
    const res = await transfer(outsider.membershipId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MEMBERSHIP_NOT_FOUND');

    const byAdmin = await adminTransfer(outsider.user.email, await asAdmin());
    expect(byAdmin.json().error.code).toBe('MEMBERSHIP_NOT_FOUND');
    expect((await roles(other.id))[outsider.user.id]).toBe('resident/approved');
  });

  it('rota de admin exige admin; condomínio inexistente → 404', async () => {
    expect((await adminTransfer(joao.user.email, mariaHeaders)).statusCode).toBe(403);

    const res = await adminTransfer(
      joao.user.email,
      await asAdmin(),
      '00000000-0000-4000-8000-000000000000',
    );
    expect(res.json().error.code).toBe('CONDOMINIUM_NOT_FOUND');
  });

  it('nunca existem dois síndicos aprovados, mesmo com trocas simultâneas', async () => {
    const ana = await createMember(app, condo);

    const results = await Promise.all([
      transfer(joao.membershipId),
      adminTransfer(ana.user.email, await asAdmin()),
    ]);

    expect(results.map((r) => r.statusCode)).toContain(200);
    const managers = Object.values(await roles()).filter((r) => r === 'manager/approved');
    expect(managers).toHaveLength(1);
  });

  describe('síndico informa a própria unidade (T23)', () => {
    function setOwnUnit(payload: Record<string, unknown>, headers = mariaHeaders) {
      return app.inject({
        method: 'PATCH',
        url: `/v1/condominiums/${condo.id}/memberships/me`,
        payload,
        headers,
      });
    }

    async function mariaRow() {
      return app.db
        .selectFrom('memberships')
        .select(['role', 'status', 'unit_id', 'unit_relation', 'can_list_spots'])
        .where('id', '=', maria.membershipId)
        .executeTakeFirstOrThrow();
    }

    beforeEach(async () => {
      // Como o síndico cadastrado pelo admin: sem unidade.
      await app.db
        .updateTable('memberships')
        .set({ unit_id: null, unit_relation: null })
        .where('id', '=', maria.membershipId)
        .execute();
    });

    it('grava a unidade sem mudar a situação; ao passar o papel, Maria continua moradora', async () => {
      const res = await setOwnUnit({ unit_id: condo.unitId, unit_relation: 'owner' });

      expect(res.statusCode).toBe(204);
      expect(await mariaRow()).toMatchObject({
        role: 'manager',
        status: 'approved',
        unit_id: condo.unitId,
        unit_relation: 'owner',
      });
      expect(sentNotifications(app)).toHaveLength(0);

      const transferred = await transfer(joao.membershipId);
      expect(transferred.json().previous_manager.became).toBe('resident');
      expect((await roles())[maria.user.id]).toBe('resident/approved');
    });

    it('síndico sem unidade precisa enviar unidade e vínculo → 400', async () => {
      for (const payload of [{}, { unit_id: condo.unitId }, { unit_relation: 'owner' }]) {
        const res = await setOwnUnit(payload);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('MANAGER_UNIT_REQUIRED');
      }
      expect((await mariaRow()).unit_id).toBeNull();
    });

    it('com unidade, pode mudar só o vínculo', async () => {
      await setOwnUnit({ unit_id: condo.unitId, unit_relation: 'owner' });

      expect((await setOwnUnit({ unit_relation: 'tenant' })).statusCode).toBe(204);
      expect(await mariaRow()).toMatchObject({ unit_id: condo.unitId, unit_relation: 'tenant' });
    });

    it('unidade de outro condomínio → 404 e nada muda', async () => {
      const other = await createCondominium(app);

      const res = await setOwnUnit({ unit_id: other.unitId, unit_relation: 'owner' });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('UNIT_NOT_FOUND');
      expect((await mariaRow()).unit_id).toBeNull();
    });

    it('inquilina com a regra do condomínio desligada perde a permissão de anunciar', async () => {
      await app.db
        .updateTable('condominiums')
        .set({ tenants_can_list_spots: false })
        .where('id', '=', condo.id)
        .execute();
      await app.db
        .updateTable('memberships')
        .set({ can_list_spots: true })
        .where('id', '=', maria.membershipId)
        .execute();

      expect(
        (await setOwnUnit({ unit_id: condo.unitId, unit_relation: 'tenant' })).statusCode,
      ).toBe(204);
      expect((await mariaRow()).can_list_spots).toBe(false);
    });

    it('morador aprovado e portaria continuam sem acesso → 403', async () => {
      const frontDesk = await createMember(app, condo, { role: 'front_desk' });
      for (const member of [joao, frontDesk]) {
        const { headers } = await signIn(app, member.user.id);
        const res = await setOwnUnit({ unit_id: condo.unitId, unit_relation: 'owner' }, headers);
        expect(res.statusCode).toBe(403);
      }
    });
  });
});
