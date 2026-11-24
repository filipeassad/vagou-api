# vagou-api

API do Vagou (aluguel interno de vagas em condomínios). Toda regra de negócio,
validação, cálculo de preço e autorização fica aqui (princípio IX).

@../vagou-specs/constitution.md

> O import acima exige o repositório `vagou-specs` clonado ao lado deste
> (`../vagou-specs`). Specs de feature: `../vagou-specs/specs/`.

## Stack

- Node.js 24 LTS, TypeScript (`strict`), ES Modules
- Fastify (HTTP), PostgreSQL 16 (Docker em desenvolvimento)
- Vitest para testes; `app.inject()` do Fastify para testar rotas sem subir servidor
- Prettier para formatação

## Estrutura de pastas (OBRIGATÓRIA)

Segue o padrão do repositório oficial [fastify/demo](https://github.com/fastify/demo),
com `@fastify/autoload`. Todo código novo DEVE seguir esta estrutura:

```
src/
├── app.ts              # plugin raiz: autoload de plugins/external → plugins/app → routes
├── server.ts           # lê a config, cria o Fastify com o logger e sobe o servidor
├── config/             # env.ts (validação das variáveis) e logger.ts. Fica fora de
│                       #   plugins/ porque é necessária ANTES de criar o Fastify
├── plugins/
│   ├── external/       # um arquivo por integração de terceiros: db.ts (Kysely), jwt.ts, swagger.ts...
│   └── app/            # do Vagou, por assunto: app/invites/invites-repository.ts,
│                       #   app/auth/password-manager.ts, app/authorization.ts
├── routes/             # a pasta vira o prefixo da URL; cada pasta tem um index.ts
│   └── v1/
│       ├── autohooks.ts        # hooks que valem para a pasta e subpastas
│       └── <assunto>/index.ts  # ex.: routes/v1/auth/index.ts → /v1/auth/...
└── schemas/            # schemas TypeBox por assunto: auth.ts, invites.ts, common.ts
test/                   # espelha src/: test/routes/v1/auth.test.ts, test/plugins/...
├── helper.ts           # buildTestApp(), testConfig(), captureLogs()
migrations/             # migrações Kysely: 0001_extensions.ts, 0002_...ts (ordem pelo nome)
scripts/                # scripts de linha de comando: migrate.ts, migrator.ts
plans/<nnn>-<feature>/  # plan.md e tasks.md de cada spec, mesmo número da spec
```

Regras:

- Rotas (`routes/`) só recebem a requisição, chamam o que está em `plugins/app/` e
  respondem. Regra de negócio e SQL NÃO ficam em `routes/`.
- Plugins que expõem algo para o resto da app (ex.: `fastify.db`) usam `fastify-plugin`.
- Arquivos em `kebab-case` (`invites-repository.ts`); um assunto por arquivo.
- Imports relativos com extensão **`.ts`** (`import { x } from './opaque-token.ts'`). O
  build reescreve para `.js` (`rewriteRelativeImportExtensions`). Motivo: o autoload
  carrega os plugins com o TypeScript nativo do Node, que não troca `.js` por `.ts`.
  Pelo mesmo motivo, só sintaxe "apagável" (`erasableSyntaxOnly`): sem `enum`, sem
  `constructor(private x)`.
- Arquivo de `plugins/` que só exporta funções (não é plugin) declara
  `export const autoload = false` (ex.: `app/auth/opaque-token.ts`).
- Plugin que usa outro declara `dependencies: ['nome']` no `fp(...)`; o autoload usa
  isso para carregar na ordem certa.
- Testes ficam em `test/`, nunca dentro de `src/`.
- Detalhes em `src/plugins/README.md`, `src/routes/README.md` e `src/schemas/README.md`.

## Comandos

- `npm run db:up` / `npm run db:down`: Postgres local (container `vagou_db`, porta **5433**)
- `npm run db:migrate` / `npm run db:rollback`: aplica as migrações pendentes / desfaz a última
- `npm run db:codegen`: regera `src/plugins/external/db-types.ts` (tipos das tabelas) a
  partir do banco local. Rodar **depois de toda migração**; nunca editar o arquivo à mão.
  Colunas com `check (... in (...))` ganham o tipo união em `.kysely-codegenrc.json`
- `npm run dev`: API em http://localhost:3333 (lê `.env`, copiar de `.env.example`)
- `npm run admin:criar -- --name "Nome" --email email@exemplo.com`: cria o admin da
  plataforma (ou promove uma conta) e imprime o link para definir a senha
- `npm run openapi:export`: gera o contrato `openapi.json` (não precisa de banco). Em
  desenvolvimento, a documentação navegável fica em http://localhost:3333/docs
- `npm test`, `npm run typecheck`, `npm run format`. O `npm test` exige o Postgres
  rodando: ele cria e migra o banco `vagou_test` sozinho (`test/global-setup.ts`). Testes
  que gravam no banco chamam `resetDatabase(db)` no `beforeEach`; os arquivos rodam um
  por vez para não apagarem os dados uns dos outros

## Convenções

- Banco de dados e código em **inglês** (tabelas, colunas, valores, variáveis).
  Mensagens exibidas ao usuário em português. Correspondência com os termos das
  specs: ver seção 3 de `plans/001-onboarding-acesso/plan.md`
- Rotas versionadas com prefixo `/v1`. Mudança incompatível = nova versão (princípio IX)
- Autenticação por token (header `Authorization`), não por sessão de navegador,
  para servir web e mobile
- Contrato OpenAPI **gerado pelo código**: toda rota declara `schema` (TypeBox) com
  `tags`, `summary` e `response`; rotas usam `FastifyPluginAsyncTypebox` para tipar
  a requisição pelo schema. O JSON fica em `GET /v1/openapi.json`
- Erros sempre no formato `{ "error": { "code", "message", "details?" } }`
  (`src/schemas/common.ts`). Erros de negócio são criados com `@fastify/error`
  (`createError('INVITE_EXPIRED', 'mensagem em português', 410)`); o error handler
  de `src/app.ts` repassa código e mensagem. Erros 5xx nunca expõem detalhes
- **Autorização (princípio I):** toda rota de condomínio fica em
  `src/routes/v1/condominiums/_cid/...` (a pasta `_cid` vira `:cid`). O `autohooks.ts`
  de `routes/v1/condominiums/` exige login e vínculo com o `:cid` em todas elas; sem
  vínculo → 404. Cada rota declara quem pode em `config: { access: ACCESS.manager }`
  (`ACCESS` em `src/plugins/app/authorization.ts`); sem declarar, vale morador ou
  síndico aprovado. Uma lista de regras vale se qualquer uma servir (ex.: a rota
  `memberships/me`). Use `request.membership` (vínculo) e `request.auth` (usuário).
  Rotas fora de condomínio que exigem login usam `onRequest: fastify.authenticate`.
  Rotas em `src/routes/v1/admin/` exigem `is_admin` (autohooks da pasta)
- Datas nas respostas usam `DateTime` (`src/schemas/common.ts`): `Date` no código, ISO 8601
  UTC no JSON
- Notificações (e-mail etc.) só por `fastify.notifier.send({ type, to, ... })`; tipos e
  textos em `src/plugins/app/notifications/messages.ts`. `NOTIFIER=console` imprime no log
  em desenvolvimento; nos testes (`memory`), conferir com `sentNotifications(app)`
- Eventos internos (plano 001, seção 6) por `fastify.events` (`src/plugins/app/events.ts`):
  `emit(nome, payload, trx)` roda os handlers em ordem, na transação de quem emite (sem
  fila). Consumidor registra com `fastify.events.on(nome, handler)`; tipos em `AppEvents`
- Testes montam cenários com `test/fixtures.ts` (`createCondominium`, `createMember`,
  `signIn`), sem passar pelo login
- Toda mudança de contrato é proposta no `plan.md` e revisada pelo time do `vagou-web`
