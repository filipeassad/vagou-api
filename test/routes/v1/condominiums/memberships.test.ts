import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCondominium, createMember, signIn } from '../../../fixtures.ts';
import { buildTestApp, sentNotifications } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

type Condo = Awaited<ReturnType<typeof createCondominium>>;
type Member = Awaited<ReturnType<typeof createMember>>;

/** Spec 001, req. 15–19: aprovar, recusar, reenviar e permissão de anunciar. */
describe('aprovação de moradores', () => {
  let app: FastifyInstance;
  let condo: Condo;
  let manager: Member;
  let managerHeaders: Record<string, string>;

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
    manager = await createMember(app, condo, { role: 'manager' });
    managerHeaders = (await signIn(app, manager.user.id)).headers;
  });

  function call(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    payload?: Record<string, unknown>,
    headers = managerHeaders,
    cid = condo.id,
  ) {
    return app.inject({
      method,
      url: `/v1/condominiums/${cid}/memberships${path}`,
      payload,
      headers,
    });
  }

  async function pendingResident(relation: 'owner' | 'tenant' = 'owner') {
    const member = await createMember(app, condo, { status: 'pending' });
    await app.db
      .updateTable('memberships')
      .set({ unit_relation: relation })
      .where('id', '=', member.membershipId)
      .execute();
    return member;
  }

  async function membership(id: string) {
    return app.db
      .selectFrom('memberships')
      .select(['status', 'can_list_spots', 'rejection_reason', 'decided_by', 'unit_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  it('lista moradores com contato e unidade, filtrando por situação; sem a portaria', async () => {
    const pending = await pendingResident();
    await createMember(app, condo, { role: 'front_desk' });

    const all = (await call('GET', '')).json().items;
    expect(all.map((m: { id: string }) => m.id)).toEqual([
      pending.membershipId,
      manager.membershipId,
    ]);
    expect(all[0]).toMatchObject({
      status: 'pending',
      user: { name: pending.user.name, email: pending.user.email, phone: '67999990000' },
      unit: { number: '101', block: { name: 'Bloco A' } },
    });

    const onlyPending = (await call('GET', '?status=pending')).json().items;
    expect(onlyPending).toHaveLength(1);
  });

  it('aprovação libera o acesso e avisa o morador', async () => {
    const joao = await pendingResident();
    const joaoHeaders = (await signIn(app, joao.user.id)).headers;
    const condoUrl = `/v1/condominiums/${condo.id}`;
    expect((await app.inject({ url: condoUrl, headers: joaoHeaders })).statusCode).toBe(403);

    const res = await call('POST', `/${joao.membershipId}/approve`, { can_list_spots: true });

    expect(res.statusCode).toBe(204);
    expect(await membership(joao.membershipId)).toMatchObject({
      status: 'approved',
      can_list_spots: true,
      decided_by: manager.user.id,
    });
    expect((await app.inject({ url: condoUrl, headers: joaoHeaders })).statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(sentNotifications(app)).toMatchObject([
        { type: 'membership_approved', to: { email: joao.user.email } },
      ]),
    );
  });

  describe('regra de inquilinos (req. 3, 17)', () => {
    beforeEach(async () => {
      await app.db
        .updateTable('condominiums')
        .set({ tenants_can_list_spots: false })
        .where('id', '=', condo.id)
        .execute();
    });

    it('aprovar inquilino podendo anunciar é recusado; sem anunciar passa', async () => {
      const tenant = await pendingResident('tenant');

      const denied = await call('POST', `/${tenant.membershipId}/approve`, {
        can_list_spots: true,
      });
      expect(denied.statusCode).toBe(409);
      expect(denied.json().error.code).toBe('TENANTS_CANNOT_LIST_SPOTS');
      expect((await membership(tenant.membershipId)).status).toBe('pending');

      const ok = await call('POST', `/${tenant.membershipId}/approve`, { can_list_spots: false });
      expect(ok.statusCode).toBe(204);

      const later = await call('PATCH', `/${tenant.membershipId}`, { can_list_spots: true });
      expect(later.json().error.code).toBe('TENANTS_CANNOT_LIST_SPOTS');
    });

    it('proprietário pode anunciar mesmo com a regra desligada', async () => {
      const owner = await pendingResident('owner');
      const res = await call('POST', `/${owner.membershipId}/approve`, { can_list_spots: true });
      expect(res.statusCode).toBe(204);
    });
  });

  it('síndico liga e desliga a permissão de anunciar de um aprovado', async () => {
    const resident = await createMember(app, condo);

    await call('PATCH', `/${resident.membershipId}`, { can_list_spots: true });
    expect((await membership(resident.membershipId)).can_list_spots).toBe(true);
    await call('PATCH', `/${resident.membershipId}`, { can_list_spots: false });
    expect((await membership(resident.membershipId)).can_list_spots).toBe(false);

    const pending = await pendingResident();
    const res = await call('PATCH', `/${pending.membershipId}`, { can_list_spots: true });
    expect(res.json().error.code).toBe('INVALID_MEMBERSHIP_STATUS');
  });

  it('recusa com motivo avisa o morador; ele corrige a unidade e volta a pendente', async () => {
    const joao = await pendingResident();
    const unit202 = await app.db
      .insertInto('units')
      .values({ condominium_id: condo.id, block_id: condo.blockId, number: '202' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const rejected = await call('POST', `/${joao.membershipId}/reject`, {
      reason: '  Unidade errada: você mora no 202 ',
    });
    expect(rejected.statusCode).toBe(204);
    expect(await membership(joao.membershipId)).toMatchObject({
      status: 'rejected',
      rejection_reason: 'Unidade errada: você mora no 202',
    });
    await vi.waitFor(() =>
      expect(sentNotifications(app)).toMatchObject([
        { type: 'membership_rejected', reason: 'Unidade errada: você mora no 202' },
      ]),
    );

    const joaoHeaders = (await signIn(app, joao.user.id)).headers;
    const me = await app.inject({ url: '/v1/me', headers: joaoHeaders });
    expect(me.json().memberships[0]).toMatchObject({
      status: 'rejected',
      rejection_reason: 'Unidade errada: você mora no 202',
    });

    const resent = await call('PATCH', '/me', { unit_id: unit202.id }, joaoHeaders);
    expect(resent.statusCode).toBe(204);
    expect(await membership(joao.membershipId)).toMatchObject({
      status: 'pending',
      rejection_reason: null,
      decided_by: null,
      unit_id: unit202.id,
    });
    await vi.waitFor(() =>
      expect(sentNotifications(app).at(-1)).toMatchObject({
        type: 'membership_pending',
        to: { email: manager.user.email },
        unitLabel: 'Bloco A, unidade 202',
      }),
    );
  });

  it('reenvio: unidade de outro condomínio é recusada; aprovado não reenvia', async () => {
    const joao = await pendingResident();
    const joaoHeaders = (await signIn(app, joao.user.id)).headers;
    const other = await createCondominium(app);

    const foreign = await call('PATCH', '/me', { unit_id: other.unitId }, joaoHeaders);
    expect(foreign.json().error.code).toBe('UNIT_NOT_FOUND');
    expect((await membership(joao.membershipId)).unit_id).toBe(condo.unitId);

    const approved = await createMember(app, condo);
    const res = await call('PATCH', '/me', {}, (await signIn(app, approved.user.id)).headers);
    expect(res.statusCode).toBe(403);
  });

  it('só cadastro pendente é aprovado ou recusado', async () => {
    const resident = await createMember(app, condo);

    const approve = await call('POST', `/${resident.membershipId}/approve`, {
      can_list_spots: false,
    });
    const reject = await call('POST', `/${resident.membershipId}/reject`, {});

    for (const res of [approve, reject]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('INVALID_MEMBERSHIP_STATUS');
    }
  });

  it('dois moradores na mesma unidade são aceitos (req. 19)', async () => {
    const first = await pendingResident('owner');
    const second = await pendingResident('tenant');

    for (const m of [first, second]) {
      const res = await call('POST', `/${m.membershipId}/approve`, { can_list_spots: false });
      expect(res.statusCode).toBe(204);
    }
    const units = await app.db
      .selectFrom('memberships')
      .select('unit_id')
      .where('id', 'in', [first.membershipId, second.membershipId])
      .where('status', '=', 'approved')
      .execute();
    expect(units.map((u) => u.unit_id)).toEqual([condo.unitId, condo.unitId]);
  });

  describe('isolamento e permissões', () => {
    it('vínculo de outro condomínio → 404 e não muda', async () => {
      const other = await createCondominium(app);
      const foreign = await createMember(app, other, { status: 'pending' });

      const res = await call('POST', `/${foreign.membershipId}/approve`, { can_list_spots: false });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('MEMBERSHIP_NOT_FOUND');
      expect((await membership(foreign.membershipId)).status).toBe('pending');
    });

    it('morador e portaria não aprovam nem listam', async () => {
      const pending = await pendingResident();
      const resident = await createMember(app, condo);
      const frontDesk = await createMember(app, condo, { role: 'front_desk' });

      for (const member of [resident, frontDesk]) {
        const headers = (await signIn(app, member.user.id)).headers;
        expect((await call('GET', '', undefined, headers)).statusCode).toBe(403);
        const res = await call(
          'POST',
          `/${pending.membershipId}/approve`,
          { can_list_spots: true },
          headers,
        );
        expect(res.statusCode).toBe(403);
      }
    });
  });
});
