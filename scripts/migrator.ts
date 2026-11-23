import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

export const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, '../migrations');

/**
 * Lê as migrações da pasta `migrations/`. Substitui o FileMigrationProvider do
 * Kysely, que monta o import com caminho do Windows (C:\...) e falha em ES Modules.
 */
class FolderMigrationProvider implements MigrationProvider {
  private readonly folder: string;

  constructor(folder: string) {
    this.folder = folder;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.folder))
      .filter((file) => /\.(ts|js)$/.test(file) && !file.endsWith('.d.ts'))
      .sort();

    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const module = (await import(pathToFileURL(path.join(this.folder, file)).href)) as Migration;
      migrations[file.replace(/\.(ts|js)$/, '')] = module;
    }
    return migrations;
  }
}

// O tipo do banco não importa para o migrador: as migrações usam o schema builder.
export function createMigrator(db: Kysely<any>, folder = MIGRATIONS_FOLDER): Migrator {
  return new Migrator({ db, provider: new FolderMigrationProvider(folder) });
}
