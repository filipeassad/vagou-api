import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEvents } from '../../../../src/plugins/app/events.ts';
import { createCondominium, createMember, signIn } from '../../../fixtures.ts';
import { buildTestApp } from '../../../helper.ts';
import { resetDatabase } from '../../../test-database.ts';

type Condo = Awaited<ReturnType<typeof createCondominium>>;
type Member = Awaited<ReturnType<typeof createMember>>;

/** Spec 001, req. 24 e 25: remoção de morador pelo síndico. */
describe('remoção de morador', () => {
  let app: FastifyInstance;
  let condo: Condo;
  let manager: Member;
  let managerHeaders: Record<string, string>;
  let removedEvents: AppEvents['membership.removed'][];
  let unsubscribe: () => void;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app.db);
    condo = await createCondominium(app);
    manager = await createMember(app, condo, { role: 'manager' });
    managerHeaders = (await signIn(app, manager.user.id)).headers;
    removedEvents = [];
    unsubscribe = app.events.on('membership.removed', async (payload) => {
      removedEvents.push(payload);
    });
  });

  afterEach(() => {
    unsubscribe();
  });

  function remove(membershipId: string, headers = managerHeaders, cid = condo.id) {
    return app.inject({
      method: 'POST',
      url: `/v1/condominiums/${cid}/memberships/${membershipId}/remove`,
      headers,
    });
  }

  function getCondominium(headers: Record<string, string>, cid = condo.id) {
    return app.inject({ method: 'GET', url: `/v1/condominiums/${cid}`, headers });
  }

  async function membership(id: string) {
    return app.db
      .selectFrom('memberships')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  async function activeSessions(userId: string) {
    const rows = await app.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
    return rows.length;
  }

  it('morador removido perde o acesso no próximo request; evento emitido', async () => {
    const resident = await createMember(app, condo);
    await app.db
      .updateTable('memberships')
      .set({ can_list_spots: true })
      .where('id', '=', resident.membershipId)
      .execute();
    const { headers } = await signIn(app, resident.user.id);
    expect((await getCondominium(headers)).statusCode).toBe(200);

    const res = await remove(resident.membershipId);

    expect(res.statusCode).toBe(204);
    const row = await membership(resident.membershipId);
    expect(row).toMatchObject({
      status: 'removed',
      can_list_spots: false,
      decided_by: manager.user.id,
    });
    // Sem outro vínculo: as sessões acabam e o token deixa de valer.
    expect(await activeSessions(resident.user.id)).toBe(0);
    expect((await getCondominium(headers)).statusCode).toBe(401);
    expect(removedEvents).toEqual([
      {
        condominiumId: condo.id,
        membershipId: resident.membershipId,
        userId: resident.user.id,
        removedBy: manager.user.id,
      },
    ]);
  });

  it('com vínculo em outro condomínio: token continua valendo lá e aqui recebe 404', async () => {
    const resident = await createMember(app, condo);
    const other = await createCondominium(app);
    await app.db
      .insertInto('memberships')
      .values({
        user_id: resident.user.id,
        condominium_id: other.id,
        unit_id: other.unitId,
        unit_relation: 'owner',
        role: 'resident',
        status: 'approved',
        origin: 'admin',
      })
      .execute();
    const { headers } = await signIn(app, resident.user.id);

    expect((await remove(resident.membershipId)).statusCode).toBe(204);

    expect(await activeSessions(resident.user.id)).toBe(1);
    const here = await getCondominium(headers);
    expect(here.statusCode).toBe(404);
    expect(here.json().error.code).toBe('CONDOMINIUM_NOT_FOUND');
    expect((await getCondominium(headers, other.id)).statusCode).toBe(200);
  });

  it('remove cadastro pendente ou recusado; o morador some da lista', async () => {
    const pending = await createMember(app, condo, { status: 'pending' });
    const rejected = await createMember(app, condo, { status: 'rejected' });

    for (const m of [pending, rejected]) {
      expect((await remove(m.membershipId)).statusCode).toBe(204);
    }

    const list = await app.inject({
      method: 'GET',
      url: `/v1/condominiums/${condo.id}/memberships`,
      headers: managerHeaders,
    });
    expect(list.json().items.map((i: { id: string }) => i.id)).toEqual([manager.membershipId]);
    expect(removedEvents).toHaveLength(2);
  });

  it('handler do evento falha → nada é gravado (mesma transação)', async () => {
    const resident = await createMember(app, condo);
    await signIn(app, resident.user.id);
    const off = app.events.on('membership.removed', async () => {
      throw new Error('falha no consumidor');
    });

    try {
      const res = await remove(resident.membershipId);
      expect(res.statusCode).toBe(500);
    } finally {
      off();
    }

    expect((await membership(resident.membershipId)).status).toBe('approved');
    expect(await activeSessions(resident.user.id)).toBe(1);
  });

  it('síndico não remove a si mesmo → 409; portaria e já removido → 404', async () => {
    const self = await remove(manager.membershipId);
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('CANNOT_REMOVE_MANAGER');
    expect((await membership(manager.membershipId)).status).toBe('approved');

    const frontDesk = await createMember(app, condo, { role: 'front_desk' });
    expect((await remove(frontDesk.membershipId)).statusCode).toBe(404);

    const resident = await createMember(app, condo);
    expect((await remove(resident.membershipId)).statusCode).toBe(204);
    const again = await remove(resident.membershipId);
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('MEMBERSHIP_NOT_FOUND');
    expect(removedEvents).toHaveLength(1);
  });

  it('morador de outro condomínio → 404 e não muda', async () => {
    const other = await createCondominium(app);
    const foreign = await createMember(app, other);

    const res = await remove(foreign.membershipId);

    expect(res.statusCode).toBe(404);
    expect((await membership(foreign.membershipId)).status).toBe('approved');
    expect(removedEvents).toHaveLength(0);
  });

  it('morador e portaria não removem → 403', async () => {
    const target = await createMember(app, condo);
    const resident = await createMember(app, condo);
    const frontDesk = await createMember(app, condo, { role: 'front_desk' });

    for (const member of [resident, frontDesk]) {
      const { headers } = await signIn(app, member.user.id);
      expect((await remove(target.membershipId, headers)).statusCode).toBe(403);
    }
    expect((await membership(target.membershipId)).status).toBe('approved');
  });

  it('removido pode se cadastrar de novo pelo QR Code (fica pendente)', async () => {
    const resident = await createMember(app, condo);
    expect((await remove(resident.membershipId)).statusCode).toBe(204);
    const { headers } = await signIn(app, resident.user.id);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/memberships',
      headers,
      payload: { public_code: condo.publicCode, unit_id: condo.unitId, unit_relation: 'owner' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('pending');
  });
});
