/**
 * Cria o admin da plataforma (plano 001, D11) ou promove uma conta existente.
 *
 *   npm run admin:criar -- --name "Fulano de Tal" --email fulano@exemplo.com
 *
 * Se a conta ainda não tem senha, imprime aqui no terminal o link para defini-la
 * (vale 24 horas). Lê DATABASE_URL e WEB_ORIGIN do ambiente (.env).
 */
import { parseArgs } from 'node:util';
import { setPasswordUrl } from '../src/plugins/app/admin/admin-service.ts';
import {
  ADMIN_SETUP_TTL_MINUTES,
  bootstrapAdmin,
} from '../src/plugins/app/admin/admin-bootstrap.ts';
import { createDb } from '../src/plugins/external/db.ts';

const { values } = parseArgs({
  options: { name: { type: 'string' }, email: { type: 'string' } },
});

if (!values.name?.trim() || !values.email?.includes('@')) {
  console.error('Uso: npm run admin:criar -- --name "Nome" --email email@exemplo.com');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL é obrigatória e não foi definida');
  process.exit(1);
}
const webOrigin = process.env.WEB_ORIGIN || 'http://localhost:5173';

const db = createDb(databaseUrl);
try {
  const result = await bootstrapAdmin(db, { name: values.name, email: values.email });
  console.log(result.created ? '✔ Admin criado.' : '✔ Conta existente promovida a admin.');
  if (result.setupToken) {
    console.log(
      `\nDefina a senha em (vale ${ADMIN_SETUP_TTL_MINUTES / 60} horas, uso único):\n` +
        `  ${setPasswordUrl(webOrigin, result.setupToken)}\n`,
    );
  } else {
    console.log('A conta já tem senha: entre normalmente.');
  }
} finally {
  await db.destroy();
}
