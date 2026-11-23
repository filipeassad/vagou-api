import createError from '@fastify/error';
import fp from 'fastify-plugin';
import { isForeignKeyViolation, isUniqueViolation, type Db } from '../../external/db.ts';

export const BlockNotFound = createError('BLOCK_NOT_FOUND', 'Bloco não encontrado.', 404);

export const BlockNameTaken = createError(
  'BLOCK_NAME_TAKEN',
  'Já existe um bloco com esse nome neste condomínio.',
  409,
);

export const BlockNotEmpty = createError(
  'BLOCK_NOT_EMPTY',
  'Este bloco tem unidades. Apague ou mova as unidades antes de apagar o bloco.',
  409,
);

export type BlockWithUnits = {
  id: string;
  name: string;
  units: { id: string; number: string }[];
};

/** Ordem natural: "2" antes de "10", "Bloco 2" antes de "Bloco 10". */
const naturalOrder = (a: string, b: string) =>
  a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });

/**
 * Blocos/torres de um condomínio (req. 2). Toda função exige `condominiumId` e filtra
 * por ele (princípio I): um id de bloco de outro condomínio responde "não encontrado".
 */
export function createBlocksRepository(db: Db) {
  return {
    /** Blocos com as suas unidades, em ordem natural. */
    async listWithUnits(condominiumId: string): Promise<BlockWithUnits[]> {
      const [blocks, units] = await Promise.all([
        db
          .selectFrom('blocks')
          .select(['id', 'name'])
          .where('condominium_id', '=', condominiumId)
          .execute(),
        db
          .selectFrom('units')
          .select(['id', 'number', 'block_id'])
          .where('condominium_id', '=', condominiumId)
          .execute(),
      ]);
      return blocks
        .sort((a, b) => naturalOrder(a.name, b.name))
        .map((block) => ({
          ...block,
          units: units
            .filter((unit) => unit.block_id === block.id)
            .sort((a, b) => naturalOrder(a.number, b.number))
            .map(({ id, number }) => ({ id, number })),
        }));
    },

    async create(condominiumId: string, name: string) {
      try {
        return await db
          .insertInto('blocks')
          .values({ condominium_id: condominiumId, name: name.trim() })
          .returning(['id', 'name'])
          .executeTakeFirstOrThrow();
      } catch (err) {
        if (isUniqueViolation(err, 'blocks_condominium_id_name_key')) throw new BlockNameTaken();
        throw err;
      }
    },

    async rename(condominiumId: string, blockId: string, name: string) {
      try {
        const row = await db
          .updateTable('blocks')
          .set({ name: name.trim() })
          .where('condominium_id', '=', condominiumId)
          .where('id', '=', blockId)
          .returning(['id', 'name'])
          .executeTakeFirst();
        if (!row) throw new BlockNotFound();
        return row;
      } catch (err) {
        if (isUniqueViolation(err, 'blocks_condominium_id_name_key')) throw new BlockNameTaken();
        throw err;
      }
    },

    /** Só apaga bloco vazio. A chave estrangeira das unidades garante isso mesmo em corrida. */
    async delete(condominiumId: string, blockId: string): Promise<void> {
      try {
        const result = await db
          .deleteFrom('blocks')
          .where('condominium_id', '=', condominiumId)
          .where('id', '=', blockId)
          .executeTakeFirst();
        if (result.numDeletedRows === 0n) throw new BlockNotFound();
      } catch (err) {
        if (isForeignKeyViolation(err)) throw new BlockNotEmpty();
        throw err;
      }
    },
  };
}

export type BlocksRepository = ReturnType<typeof createBlocksRepository>;

export default fp(
  async function blocksRepositoryPlugin(fastify) {
    fastify.decorate('blocksRepository', createBlocksRepository(fastify.db));
  },
  { name: 'blocks-repository', dependencies: ['db'] },
);

declare module 'fastify' {
  interface FastifyInstance {
    blocksRepository: BlocksRepository;
  }
}
