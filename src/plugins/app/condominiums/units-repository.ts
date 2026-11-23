import createError from '@fastify/error';
import fp from 'fastify-plugin';
import { isForeignKeyViolation, isUniqueViolation, type Db } from '../../external/db.ts';
import { BlockNotFound } from './blocks-repository.ts';

export const UnitNotFound = createError('UNIT_NOT_FOUND', 'Unidade não encontrada.', 404);

export const UnitNumberTaken = createError(
  'UNIT_NUMBER_TAKEN',
  'Já existe uma unidade com esse número neste bloco.',
  409,
);

export const UnitHasResidents = createError(
  'UNIT_HAS_RESIDENTS',
  'Esta unidade tem moradores aprovados ou aguardando aprovação. Remova-os antes de apagar.',
  409,
);

/**
 * Unidade que já teve morador ou convite não pode ser apagada: o histórico (vínculos,
 * convites e, nos próximos planos, reservas) aponta para ela. Erro de digitação se
 * corrige renomeando (revisão do plano, T13).
 */
export const UnitHasHistory = createError(
  'UNIT_HAS_HISTORY',
  'Esta unidade já teve moradores ou convites e não pode ser apagada. Se o número está errado, edite a unidade.',
  409,
);

export type Unit = { id: string; block_id: string; number: string };

/** Unidades de um condomínio (req. 2). Toda função filtra por `condominiumId` (princípio I). */
export function createUnitsRepository(db: Db) {
  async function assertBlock(executor: Db, condominiumId: string, blockId: string) {
    const block = await executor
      .selectFrom('blocks')
      .select('id')
      .where('condominium_id', '=', condominiumId)
      .where('id', '=', blockId)
      .executeTakeFirst();
    if (!block) throw new BlockNotFound();
  }

  return {
    async create(condominiumId: string, input: { blockId: string; number: string }): Promise<Unit> {
      await assertBlock(db, condominiumId, input.blockId);
      try {
        return await db
          .insertInto('units')
          .values({
            condominium_id: condominiumId,
            block_id: input.blockId,
            number: input.number.trim(),
          })
          .returning(['id', 'block_id', 'number'])
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err, 'units_block_id_number_key')) throw new UnitNumberTaken();
        throw err;
      }
    },

    /** Renomeia e/ou move para outro bloco do mesmo condomínio. */
    async update(
      condominiumId: string,
      unitId: string,
      patch: { blockId?: string; number?: string },
    ): Promise<Unit> {
      if (patch.blockId) await assertBlock(db, condominiumId, patch.blockId);
      try {
        const row = await db
          .updateTable('units')
          .set({
            ...(patch.blockId !== undefined && { block_id: patch.blockId }),
            ...(patch.number !== undefined && { number: patch.number.trim() }),
          })
          .where('condominium_id', '=', condominiumId)
          .where('id', '=', unitId)
          .returning(['id', 'block_id', 'number'])
          .executeTakeFirst();
        if (!row) throw new UnitNotFound();
        return row;
      } catch (err) {
        if (isUniqueViolation(err, 'units_block_id_number_key')) throw new UnitNumberTaken();
        throw err;
      }
    },

    /**
     * Apaga a unidade só se nunca foi usada. Com morador pendente/aprovado →
     * `UnitHasResidents`; com qualquer outro histórico → `UnitHasHistory`. As chaves
     * estrangeiras garantem o mesmo se um vínculo/convite surgir no meio.
     */
    async delete(condominiumId: string, unitId: string): Promise<void> {
      await db.transaction().execute(async (trx) => {
        const unit = await trx
          .selectFrom('units')
          .select('id')
          .where('condominium_id', '=', condominiumId)
          .where('id', '=', unitId)
          .forUpdate()
          .executeTakeFirst();
        if (!unit) throw new UnitNotFound();

        const memberships = await trx
          .selectFrom('memberships')
          .select('status')
          .where('condominium_id', '=', condominiumId)
          .where('unit_id', '=', unitId)
          .execute();
        if (memberships.some((m) => m.status === 'pending' || m.status === 'approved')) {
          throw new UnitHasResidents();
        }

        try {
          await trx.deleteFrom('units').where('id', '=', unitId).execute();
        } catch (err) {
          if (isForeignKeyViolation(err)) {
            throw new UnitHasHistory();
          }
          throw err;
        }
      });
    },
  };
}

export type UnitsRepository = ReturnType<typeof createUnitsRepository>;

export default fp(
  async function unitsRepositoryPlugin(fastify) {
    fastify.decorate('unitsRepository', createUnitsRepository(fastify.db));
  },
  { name: 'units-repository', dependencies: ['db'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    unitsRepository: UnitsRepository;
  }
}
