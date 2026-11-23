# Plano 001 — Onboarding e controle de acesso (API)

> **Spec:** [vagou-specs/specs/001-onboarding-acesso/spec.md](../../../vagou-specs/specs/001-onboarding-acesso/spec.md)
> **Discoveries:** [login-e-cadastro](../../../vagou-specs/discovery/login-e-cadastro.md),
> [sessao-jwt](../../../vagou-specs/discovery/sessao-jwt.md)
> **Status:** proposta, aguardando revisão | **Data:** 2026-11-22

## 1. Resumo

A API passa a ter: condomínios com blocos e unidades, usuários com senha, vínculos
(usuário ↔ unidade ↔ condomínio) com papéis e status, cadastro pelo QR Code com
aprovação do síndico, convites individuais pré-aprovados, login com sessão longa
(JWT + refresh token), recuperação de senha, acesso da portaria e troca de síndico.
Tudo isolado por condomínio (princípio I).

Ficam **fora** deste plano, mas preparados:

- req. 24 (vagas somem da busca) → implementado no plano 002, lendo o status do vínculo;
- req. 25 (cancelar/estornar reservas do removido) → implementado no plano 006; aqui
  só emitimos o evento "morador removido".

## 2. Decisões técnicas

| #   | Decisão                                                                                                                                                                                                                                                                                                                                                           | Atende                                                                                              | Alternativas descartadas                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| D1  | **Contrato da API em OpenAPI 3.1**, gerado a partir dos schemas das rotas (TypeBox + `@fastify/swagger`), exportado para `openapi.json` versionado no repositório                                                                                                                                                                                                 | Princípio IX (contrato documentado e versionado); revisão pelo time web                             | Escrever o OpenAPI à mão (desatualiza); GraphQL (complexo para o tamanho do time)                               |
| D2  | **Validação de entrada com TypeBox** (pacote `typebox` 1.x + `@fastify/type-provider-typebox`): o mesmo schema valida a requisição, tipa o TypeScript e gera o contrato                                                                                                                                                                                           | req. 7, 8; D1                                                                                       | Zod (precisaria de conversão para JSON Schema)                                                                  |
| D3  | **Acesso ao banco com Kysely** (query builder tipado) + **migrações SQL versionadas** do próprio Kysely                                                                                                                                                                                                                                                           | Todos os modelos; o plano 002 precisará de constraint de exclusão em SQL puro, que o Kysely permite | ORM (Prisma/Drizzle) esconde SQL e complica a constraint do princípio IV                                        |
| D4  | **Senha com Argon2id** (`@node-rs/argon2`, binário pré-compilado, sem toolchain C++)                                                                                                                                                                                                                                                                              | req. 20; princípio VI                                                                               | bcrypt (aceitável, mas OWASP recomenda Argon2id)                                                                |
| D5  | **Sessão: opção C do discovery.** Access token JWT de **15 min** (claims: `sub`, `sid`, `cid`, `iat`, `exp`, assinatura HS256 com `kid`) + refresh token opaco de **90 dias** (portaria: **30 dias**, computador compartilhado), guardado como hash, **rotacionado a cada uso** com **detecção de reuso**. Toda requisição autenticada confere o vínculo no banco | req. 20, 24 (perda de acesso imediata); princípios I e IX                                           | JWT longo (não revoga); sessão só no banco (válida, mas JWT deixa a porta aberta para outros serviços)          |
| D6  | **Transporte dos tokens:** access token sempre no header `Authorization: Bearer`. Refresh token em cookie `HttpOnly; Secure; SameSite=Strict; Path=/v1/auth` para o web **ou** no corpo da requisição para clientes móveis                                                                                                                                        | Princípio IX com exceção explícita do cookie (ver seção 7); segurança contra XSS no web             | Refresh em `localStorage` (exposto a XSS)                                                                       |
| D7  | **Bibliotecas de auth:** `@fastify/jwt` (assinar/verificar), `@fastify/cookie`, `@fastify/rate-limit` (em memória, uma instância)                                                                                                                                                                                                                                 | req. 22; D5, D6                                                                                     | `jose` direto (mais código de integração)                                                                       |
| D8  | **Isolamento por condomínio:** toda tabela de negócio tem `condominium_id`. Um plugin de autorização resolve o vínculo do usuário no condomínio da rota (`/v1/condominiums/:cid/...`) e injeta `request.vinculo`; repositórios **exigem** `condominiumId` como parâmetro                                                                                          | req. 26; princípio I                                                                                | Filtrar só no front (proibido); Row Level Security no Postgres (bom, mas mais complexo para começar; reavaliar) |
| D9  | **Notificações atrás de um adaptador** (`Notificador`), com implementação `console` (desenvolvimento/testes) e `email`. O fornecedor de e-mail (Cloudflare Email Service ou Resend) é escolhido antes do deploy; WhatsApp entra quando a conta Meta for aprovada                                                                                                  | req. 9, 11, 16, 18, 21; princípio VIII                                                              | Acoplar a um fornecedor agora (Cloudflare ainda em beta)                                                        |
| D10 | **Tokens de convite e de redefinição de senha:** 32 bytes aleatórios em base64url, guardados só como **hash SHA-256**, uso único, com validade                                                                                                                                                                                                                    | req. 10, 12–14, 21; princípio VI                                                                    | Códigos curtos (adivinháveis)                                                                                   |
| D11 | **Admin = usuário com `is_admin = true`**, o primeiro é criado por script (`npm run admin:criar`). O admin usa uma **tela de admin no `vagou-web`**, que consome as rotas `/v1/admin/*`                                                                                                                                                                           | req. 1                                                                                              | Usar só a API, sem tela (descartado na revisão)                                                                 |
| D12 | **Portaria = usuário com vínculo de papel `front_desk`**, sem unidade, um por condomínio, com e-mail/senha definidos pelo síndico                                                                                                                                                                                                                                 | req. 4                                                                                              | Conta compartilhada sem usuário (perde o controle de sessão)                                                    |
| D13 | **Logs sem dados pessoais:** `redact` do pino para `authorization`, `cookie`, `senha`, `token`, `email`, `telefone`                                                                                                                                                                                                                                               | Princípio VI                                                                                        | —                                                                                                               |
| D14 | **Configuração validada na inicialização** (TypeBox sobre `process.env`): a API não sobe sem `DATABASE_URL`, `JWT_SECRET` etc.                                                                                                                                                                                                                                    | Restrições técnicas (segredos só em variável de ambiente)                                           | —                                                                                                               |

### Dependências novas (justificativa, princípio VIII)

| Pacote                                                   | Por quê                                                  |
| -------------------------------------------------------- | -------------------------------------------------------- |
| `kysely`, `pg`                                           | Acesso ao Postgres tipado + driver (D3)                  |
| `typebox`, `@fastify/type-provider-typebox`              | Schemas únicos para validação, tipos e contrato (D1, D2) |
| `@fastify/swagger`, `@fastify/swagger-ui`                | Gerar e visualizar o OpenAPI (D1)                        |
| `@fastify/jwt`, `@fastify/cookie`, `@fastify/rate-limit` | Sessão e proteção do login (D5–D7)                       |
| `@node-rs/argon2`                                        | Hash de senha (D4)                                       |

Todas sem custo. Nenhuma infraestrutura nova além do Postgres já previsto.

## 2.1 Estrutura de pastas

Padrão do repositório oficial [fastify/demo](https://github.com/fastify/demo) com
`@fastify/autoload`, adaptado: `routes/v1/` (versão da API), Kysely e Postgres no
lugar de knex e MySQL, Vitest no lugar do test runner do Node. A estrutura completa
e as regras estão no `CLAUDE.md` deste repositório. Onde cada parte deste plano fica:

| Parte do plano                                                     | Pasta                                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Configuração e logger (D13, D14)                                   | `src/config/env.ts`, `src/config/logger.ts`                                   |
| Banco Kysely (D3), JWT, cookie, rate limit, swagger (D1, D5–D7)    | `src/plugins/external/<nome>.ts`                                              |
| Repositórios, hash de senha, notificador, autorização (D4, D8, D9) | `src/plugins/app/<assunto>/...`                                               |
| Rotas da seção 4                                                   | `src/routes/v1/<assunto>/index.ts` (ex.: `routes/v1/public/invites/index.ts`) |
| Isolamento por condomínio (D8)                                     | `src/routes/v1/condominiums/autohooks.ts`                                     |
| Schemas TypeBox (D2)                                               | `src/schemas/<assunto>.ts`                                                    |
| Migrações (T2, T4)                                                 | `migrations/` + `scripts/migrate.ts` e `scripts/migrator.ts`                  |
| Testes                                                             | `test/`, espelhando `src/`                                                    |

## 3. Modelo de dados

Nomes de tabelas, colunas e valores em **inglês** (padrão do código e do banco). Os
textos exibidos ao usuário continuam em português.

### Correspondência com os termos das specs

| Spec (português)                          | Banco (inglês)                                            |
| ----------------------------------------- | --------------------------------------------------------- |
| usuário                                   | `users`                                                   |
| condomínio                                | `condominiums`                                            |
| bloco / torre                             | `blocks`                                                  |
| unidade                                   | `units`                                                   |
| vínculo                                   | `memberships`                                             |
| morador / síndico / portaria              | `role`: `resident` / `manager` / `front_desk`             |
| proprietário / inquilino                  | `unit_relation`: `owner` / `tenant`                       |
| pendente / aprovado / recusado / removido | `status`: `pending` / `approved` / `rejected` / `removed` |
| permissão de anunciar                     | `can_list_spots`                                          |
| convite                                   | `invites`                                                 |
| sessão                                    | `sessions`                                                |
| redefinição de senha                      | `password_resets`                                         |

### Tabelas

```sql
-- users (uma conta por pessoa; e-mail único, req. 23)
users (
  id uuid pk,
  name text not null,
  email citext unique not null,
  phone text not null,
  password_hash text,                -- null até o síndico criado pelo admin definir a senha
  is_admin boolean not null default false,
  failed_login_attempts int not null default 0,
  locked_until timestamptz,          -- req. 22
  created_at timestamptz not null default now()
)

condominiums (
  id uuid pk,
  name text not null,
  address text not null,
  public_code text unique not null,                     -- link/QR Code do condomínio (req. 6), aleatório
  tenants_can_list_spots boolean not null default true, -- req. 3
  invite_validity_days int not null default 7,          -- req. 13
  timezone text not null default 'America/Sao_Paulo',
  created_at timestamptz not null default now()
)

blocks (id uuid pk, condominium_id fk, name text, unique (condominium_id, name))

units (
  id uuid pk, condominium_id fk, block_id fk, number text,
  unique (block_id, number)
)

-- vínculo de um usuário com um condomínio (req. 15–19, 24)
memberships (
  id uuid pk,
  user_id fk, condominium_id fk,
  unit_id fk null,                                -- null para a portaria
  role text check (role in ('resident','manager','front_desk')),
  unit_relation text null check (unit_relation in ('owner','tenant')),
  status text check (status in ('pending','approved','rejected','removed')),
  can_list_spots boolean not null default false,  -- req. 17
  origin text check (origin in ('qr_code','invite','admin','manager')),
  rejection_reason text,
  decided_by fk users null, decided_at timestamptz,
  created_at timestamptz not null default now()
)
-- um vínculo ativo por usuário e condomínio
unique index on memberships (user_id, condominium_id) where status <> 'removed'
-- no máximo um síndico e uma portaria ativos por condomínio (req. 4, 5)
unique index on memberships (condominium_id) where role = 'manager' and status = 'approved'
unique index on memberships (condominium_id) where role = 'front_desk' and status = 'approved'

invites (
  id uuid pk, condominium_id fk, unit_id fk,
  token_hash bytea unique not null,               -- D10
  unit_relation text, can_list_spots boolean,     -- definidos pelo síndico ao gerar (req. 17)
  recipient_email citext null, recipient_phone text null,
  created_by fk users, created_at timestamptz,
  expires_at timestamptz not null,                -- req. 13
  used_at timestamptz, used_by fk users,          -- uso único (req. 10)
  revoked_at timestamptz                          -- req. 14
)

sessions (
  id uuid pk, user_id fk,
  refresh_token_hash bytea unique not null,
  created_at, expires_at, last_used_at,
  revoked_at timestamptz, replaced_by uuid null,  -- rotação/reuso (D5)
  user_agent text
)

password_resets (
  id uuid pk, user_id fk, token_hash bytea unique,
  expires_at timestamptz, used_at timestamptz
)
```

Notas:

- Implementado em `migrations/0002_onboarding.ts` (T4). Diferenças em relação ao
  esboço acima: `users.phone` aceita null (a portaria não tem telefone; para moradores
  a API exige); `units` também usa chave composta para o bloco ser do mesmo
  condomínio; checks garantem que morador tem unidade e que a portaria não tem unidade
  nem permissão de anunciar; `invite_validity_days` entre 1 e 90.
- `memberships.unit_id` precisa pertencer ao mesmo `condominium_id` (checado na
  aplicação e por chave composta `(condominium_id, unit_id)` → `units (condominium_id, id)`).
- Aceite de convite usa `UPDATE invites SET used_at = now() ... WHERE used_at IS NULL
AND revoked_at IS NULL AND expires_at > now() RETURNING *` para garantir **uso
  único mesmo com duas pessoas ao mesmo tempo**.
- Bloqueio de login (req. 22): 5 falhas seguidas → `locked_until = now() + 15 min`;
  zera no sucesso. Além disso, rate limit por IP na rota de login.

### Conexão com o banco

- Driver `pg` com **pool** de conexões, configurado por `DATABASE_URL`.
- Plugin do Fastify cria a instância Kysely e a expõe como `app.db`; fecha o pool
  no desligamento da API (`onClose`).
- Tipos das tabelas gerados a partir do banco (`kysely-codegen`) depois de cada
  migração, para o TypeScript conhecer as colunas.
- Transações com `db.transaction().execute(...)` nas operações que mexem em mais de
  uma tabela (ex.: aceitar convite = criar usuário + vínculo + marcar convite).
- Testes usam um banco separado (`DATABASE_URL_TEST`), migrado antes da suíte e
  limpo entre os testes.

## 4. Contrato da API (`/v1`)

Mudanças propostas para revisão do time `vagou-web`. Respostas de erro no formato
`{ "error": { "code": "...", "message": "..." } }`.

### Público (sem login)

| Método e rota                               | Uso                                                                                                                 | Req.   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| `GET /v1/public/condominiums/:code`         | Nome do condomínio + blocos e unidades para o cadastro pelo QR Code                                                 | 6, 8   |
| `POST /v1/public/condominiums/:code/signup` | Cria usuário + vínculo **pendente**; notifica o síndico                                                             | 7, 9   |
| `POST /v1/public/invites/lookup`            | `{ token }` → dados do convite (condomínio, bloco, unidade) ou motivo de inválido. Token no corpo, não na URL (T18) | 12, 13 |
| `POST /v1/public/invites/accept`            | `{ token, ... }` → cria usuário + vínculo **aprovado**; marca o convite como usado                                  | 10, 12 |

### Autenticação

| Método e rota                   | Uso                                                                          | Req.   |
| ------------------------------- | ---------------------------------------------------------------------------- | ------ |
| `POST /v1/auth/login`           | E-mail + senha → access token + refresh (cookie ou corpo)                    | 20, 22 |
| `POST /v1/auth/refresh`         | Troca o refresh por novo par (rotação)                                       | 20     |
| `POST /v1/auth/logout`          | Revoga a sessão atual                                                        | —      |
| `POST /v1/auth/forgot-password` | Envia link de redefinição; resposta sempre igual                             | 21     |
| `POST /v1/auth/reset-password`  | Token + nova senha; revoga todas as sessões                                  | 21     |
| `GET /v1/me`                    | Usuário logado + seus vínculos (condomínio, papel, status, `can_list_spots`) | 15     |
| `POST /v1/me/memberships`       | Quem já tem conta entra em outro condomínio pelo QR Code (pendente, T16)     | 7, 9   |
| `POST /v1/me/invites/accept`    | Quem já tem conta aceita um convite `{ token }` (T18)                        | 10, 12 |

### Admin (`is_admin`)

| Método e rota                              | Uso                                                                     | Req. |
| ------------------------------------------ | ----------------------------------------------------------------------- | ---- |
| `POST /v1/admin/condominiums`              | Cria condomínio + síndico (envia e-mail para o síndico definir a senha) | 1    |
| `GET /v1/admin/condominiums`               | Lista condomínios                                                       | 1    |
| `POST /v1/admin/condominiums/:cid/manager` | Passa o papel de síndico para outro morador                             | 5    |

### Condomínio (síndico)

| Método e rota                                                   | Uso                                                                                                          | Req.       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------- |
| `GET /v1/condominiums/:cid`                                     | Dados e configurações (qualquer vínculo aprovado vê os dados básicos)                                        | 2, 26      |
| `PATCH /v1/condominiums/:cid`                                   | Nome, endereço, `tenants_can_list_spots`, `invite_validity_days`                                             | 2, 3, 13   |
| `GET/POST/PATCH/DELETE /v1/condominiums/:cid/blocks[/:blockId]` | Manter blocos                                                                                                | 2          |
| `POST/PATCH/DELETE /v1/condominiums/:cid/units[/:unitId]`       | Manter unidades                                                                                              | 2          |
| `GET /v1/condominiums/:cid/memberships?status=`                 | Lista moradores (pendentes, aprovados...)                                                                    | 15         |
| `POST /v1/condominiums/:cid/memberships/:id/approve`            | `{ can_list_spots }`; respeita regra de inquilino                                                            | 16, 17     |
| `POST /v1/condominiums/:cid/memberships/:id/reject`             | `{ reason }`                                                                                                 | 18         |
| `POST /v1/condominiums/:cid/memberships/:id/remove`             | Remove; sem outro vínculo, revoga sessões; emite evento                                                      | 24, 25     |
| `PATCH /v1/condominiums/:cid/memberships/:id`                   | Alterar `can_list_spots`                                                                                     | 17         |
| `POST /v1/condominiums/:cid/manager`                            | Síndico atual passa o papel                                                                                  | 5          |
| `POST /v1/condominiums/:cid/invites`                            | Gera convite `{ unit_id, unit_relation, can_list_spots }` → devolve o **link** (para o síndico compartilhar) | 10, 11, 17 |
| `GET /v1/condominiums/:cid/invites`                             | Lista convites e situação (pendente, usado, expirado, revogado)                                              | 10         |
| `POST /v1/condominiums/:cid/invites/:id/revoke`                 | Revoga                                                                                                       | 14         |
| `POST /v1/condominiums/:cid/invites/:id/send`                   | `{ channel: "email", recipient }` envio pela plataforma; gera link novo (T19)                                | 11         |
| `PUT /v1/condominiums/:cid/front-desk`                          | Cria ou redefine o acesso da portaria (e-mail + senha)                                                       | 4          |
| `GET /v1/condominiums/:cid/front-desk`                          | E-mail do acesso da portaria (ou null)                                                                       | 4          |

### Morador

| Método e rota                                | Uso                                                                             | Req. |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ---- |
| `PATCH /v1/condominiums/:cid/memberships/me` | Corrigir unidade/vínculo de um cadastro pendente ou recusado (volta a pendente) | 18   |

Observação: o token do convite só aparece no link entregue ao síndico; a API nunca o
devolve de novo (guarda só o hash).

Fora das tabelas: `GET /v1/health` (monitoramento) e `GET /v1/openapi.json` (o próprio
contrato). O `openapi.json` exportado na T21 tem todas as rotas acima, com corpo, respostas
e códigos de erro de cada uma; ele é a referência, e esta tabela é o resumo.

## 5. Autorização

| Quem                                      | Pode                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| Visitante sem login                       | Rotas `/v1/public/*`, login, esqueci/redefinir senha                         |
| Usuário com vínculo `pendente`/`recusado` | `GET /v1/me`, corrigir e reenviar o próprio vínculo. Nada de vagas (req. 15) |
| Morador `aprovado`                        | Dados básicos do condomínio; demais features (planos 002+)                   |
| Síndico `aprovado`                        | Tudo de morador + rotas de gestão do condomínio dele                         |
| Portaria `aprovado`                       | Só rotas da portaria (plano 005)                                             |
| Admin                                     | `/v1/admin/*`                                                                |

O plugin de autorização (D8), em toda rota `/v1/condominiums/:cid/*`:

1. valida o access token (assinatura, expiração);
2. busca o vínculo do usuário com `:cid` e confere `status = 'approved'` (ou o
   permitido pela rota) e o papel exigido;
3. se não houver vínculo com `:cid`, responde **404** (não revela que o condomínio existe).

## 6. Eventos internos

| Evento                                                               | Emitido quando            | Consumido por                                                     |
| -------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| `membership.removed`                                                 | Síndico remove um morador | Plano 002 (ocultar vagas), plano 006 (cancelar/estornar reservas) |
| `membership.pending` / `membership.approved` / `membership.rejected` | Mudança de status         | Notificador                                                       |

No MVP, eventos são chamadas síncronas dentro da mesma transação/processo (sem fila),
para respeitar o orçamento (princípio VIII).

## 7. Conferência da constituição

| Princípio                      | Como é atendido                                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Condomínio fechado          | `condominium_id` em toda tabela; plugin D8; repositórios exigem `condominiumId`; 404 para condomínio alheio; testes de isolamento                                                                                                      |
| II. Dinheiro                   | Não se aplica (sem pagamentos neste plano)                                                                                                                                                                                             |
| III. Webhook idempotente       | Não se aplica                                                                                                                                                                                                                          |
| IV. Sem reservas sobrepostas   | Não se aplica                                                                                                                                                                                                                          |
| V. Passe reflete o estado real | Não se aplica diretamente; o status do vínculo é consultado a cada requisição, base para o plano 005                                                                                                                                   |
| VI. Dados pessoais             | Sem CPF no cadastro; senha Argon2id; tokens só como hash; `redact` nos logs; portaria não vê e-mail/telefone                                                                                                                           |
| VII. Regras com teste          | Testes para: aprovação/recusa, regra de inquilino, convite (expiração, revogação, uso único concorrente), bloqueio de login, rotação/reuso de refresh, remoção revoga acesso, isolamento                                               |
| VIII. Custo                    | Dependências sem custo; sem infraestrutura nova; e-mail no plano gratuito do fornecedor                                                                                                                                                |
| IX. API é o produto            | Regras só na API; contrato OpenAPI versionado; Bearer token. **Exceção justificada:** refresh token em cookie `HttpOnly` só para o web e só na rota `/v1/auth/*` (D6); clientes móveis usam o corpo. Atualizar o `CLAUDE.md` desta API |

## 8. Riscos e pendências

- **Fornecedor de e-mail** não definido (Cloudflare Email Service em beta × Resend).
  Não bloqueia: em desenvolvimento usa o notificador `console`.
- **WhatsApp** (req. 11) depende da aprovação da conta Meta; entra em tarefa posterior.
- **Hospedagem** não definida: afeta CORS e domínio do cookie (D6). Em desenvolvimento,
  o proxy do Vite deixa web e API na mesma origem.

## 9. Perguntas para revisão

1. ~~**D1:** OpenAPI gerado pelo código como formato do contrato. De acordo?~~
   Respondida: sim (ver seção 10).
2. ~~**D11:** sem tela de admin no MVP?~~ Respondida: **com** tela de admin (seção 10).
3. ~~**D5:** sessão da portaria?~~ Respondida: síndico 90 dias, portaria 30 dias (seção 10).

### Revisão do contrato pelo `vagou-web` (T21, aberta em 2026-11-23)

Contrato: `openapi.json` na raiz deste repositório (31 caminhos; navegável em
http://localhost:3333/docs com `npm run dev`). O web pode trabalhar em paralelo com mock
a partir dele. Pontos para o time do web conferir e responder aqui:

4. **Proxy do Vite e o cookie do refresh (bloqueia o login no web em desenvolvimento).**
   O `vite.config.ts` do web encaminha `/api/*` e tira o `/api`. A API grava o cookie com
   `Path=/v1/auth`, mas o navegador chama `/api/v1/auth/refresh`: o cookie não é enviado e
   o refresh falha. Proposta: o proxy encaminhar `/v1` sem reescrever (o navegador usa o
   mesmo caminho que a API). Na hospedagem, servir a API no mesmo caminho `/v1`.
5. **Páginas do web que a API põe nos links** (e-mails e respostas). O web precisa ter:
   `/entrar`, `/convite#token=...`, `/redefinir-senha#token=...`,
   `/definir-senha#token=...` e `/condominios/:cid/moradores`. O token vem no
   **fragmento** (`#token=`): a tela lê o fragmento e manda o token no corpo de
   `/v1/public/invites/lookup`, `/v1/public/invites/accept`, `/v1/me/invites/accept` e
   `/v1/auth/reset-password`. Os nomes servem?
6. **Login do web:** o web não manda `refresh_token` no corpo; recebe o refresh no cookie
   (`HttpOnly`, `SameSite=Strict`) e o access token (15 min) no corpo. Refresh e logout
   são chamados **sem corpo**. Quando o access token vence, a API responde 401 e o web
   chama `/v1/auth/refresh` uma vez antes de mandar para o login.
7. **Erros:** sempre `{ error: { code, message } }`. A `message` já está em português e
   pode ser mostrada ao usuário; o web decide pela `code` quando precisa de tela própria
   (ex.: `INVITE_EXPIRED`, `ALREADY_MEMBER`, `CANNOT_REMOVE_MANAGER`). 502/503 com
   código do Vagou (ex.: `INVITE_SEND_FAILED`) também trazem mensagem para o usuário.
8. **Fluxo pós-cadastro:** `GET /v1/me` traz os vínculos com `status`. O web decide a tela
   pelo vínculo (pendente → espera; recusado → motivo + corrigir com
   `PATCH .../memberships/me`; aprovado → app). Falta alguma informação para essas telas?
9. **Campos de cadastro:** telefone aceita dígitos, espaço, `+`, `-` e parênteses (8 a 20
   caracteres) e a API guarda só os dígitos; senha de 8 a 128 caracteres. O web valida
   igual para dar retorno rápido, mas a API é quem decide.

## 10. Decisões da revisão

- **Idioma:** banco, código, rotas e campos da API em inglês; mensagens ao usuário
  em português (2026-11-22).
- **Acesso ao banco:** manter o query builder Kysely por enquanto (D3) (2026-11-22).
- **Contrato (D1):** OpenAPI gerado pelo código. A API vem primeiro; quando o
  `vagou-web` começar a consumir o contrato, avaliamos se precisa mudar algo.
  Registrado na constituição 1.5.0 (2026-11-22).
- **Admin (D11):** terá tela no `vagou-web` (entra no plano 001 do web). Na API nada
  muda: as rotas `/v1/admin/*` já existem; o primeiro admin continua sendo criado
  pelo script (2026-11-22).
- **Sessão (D5):** refresh token de 90 dias para moradores e síndico; **30 dias para a
  portaria** (2026-11-22).
- **Claims do access token (T6):** só `sub` e `sid`. O `cid` saiu: o condomínio vem
  da URL (`/v1/condominiums/:cid/...`) e o vínculo é conferido no banco a cada
  requisição (D8), então trocar de condomínio não exige token novo (2026-11-23).
- **Login (T6):** corpo `{ email, password, client? }`; `client = "web"` (padrão)
  recebe o refresh no cookie `vagou_refresh`, `"mobile"` no corpo. Senha errada e
  e-mail inexistente → 401 `INVALID_CREDENTIALS` (mesma mensagem); conta bloqueada
  → 429 `LOGIN_BLOCKED`; mais de 10 tentativas por minuto do mesmo IP → 429
  `RATE_LIMITED` (2026-11-23).
- **Refresh e logout (T7):** o refresh renova a validade da sessão a cada troca
  (90 dias, ou 30 para a portaria, contados da última troca). Reuso de um refresh já
  trocado há mais de **10 s** encerra todas as sessões do usuário; dentro desses 10 s
  só responde 401, para duas abas do web que renovam juntas não derrubarem o login.
  Logout sempre responde 204 e apaga o cookie (2026-11-23).
- **Autorização (T8):** além do vínculo, cada requisição autenticada confere se a
  sessão do token está ativa, então logout e reuso de refresh cortam o acesso na hora
  (não esperam os 15 min do JWT). Rotas de condomínio declaram `config.access`; o
  padrão é morador ou síndico aprovado, e a portaria só entra onde for incluída
  explicitamente. Vínculo pendente/recusado → 403 com código próprio
  (`MEMBERSHIP_PENDING`, `MEMBERSHIP_REJECTED`) para o app mostrar a tela certa
  (2026-11-23).
- **Notificador (T9):** escolhido por `NOTIFIER` (`console` | `memory` | `email`). Em
  produção a configuração exige `email` + `EMAIL_FROM`, e a API **não sobe** até o
  fornecedor estar integrado (só a interface `EmailTransport` existe). Falha do
  fornecedor vira exceção; cada tarefa decide se a falha derruba a requisição (ex.: T10
  responde igual mesmo se o envio falhar, para não revelar se o e-mail existe).
- **Esqueci/redefinir senha (T10):**
  - `forgot-password { email }` → sempre **202** sem corpo. O envio do e-mail não é
    aguardado (tempo de resposta igual; falha do fornecedor só vai para o log). No
    máximo 1 e-mail por minuto por conta; pedir de novo invalida o link anterior.
  - Link `WEB_ORIGIN/redefinir-senha#token=...`: o token vai no **fragmento** (`#`), que
    o navegador não envia a servidores nem no Referer (princípio VI: token fora de URLs
    que chegam a logs). A tela do web lê o fragmento e envia o token no corpo.
  - `reset-password { token, password }` → **204**, sem login automático. Encerra todas
    as sessões e desfaz o bloqueio de login. Token inválido, usado ou vencido → 400
    `INVALID_RESET_TOKEN` (uma mensagem só).
  - Rate limit: 5/min por IP no forgot, 10/min no reset.
- **`GET /v1/me` (T11):** `{ id, name, email, phone, is_admin, memberships: [...] }`.
  Cada vínculo: `id`, `role`, `status`, `can_list_spots`, `unit_relation`,
  `rejection_reason`, `condominium { id, name, timezone }` e
  `unit { id, number, block { id, name } }` (null para a portaria). Vínculos removidos
  não aparecem; ordem do mais antigo ao mais novo.
- **Admin (T12):**
  - `POST /v1/admin/condominiums { name, address, timezone?, manager { name, email, phone? } }`
    → 201 com `{ id, name, address, public_code, timezone, created_at, manager }`.
    `GET` → `{ items: [...] }` por nome, sem paginação. Não admin → 403 `FORBIDDEN`.
  - O síndico entra **aprovado e sem unidade** (o banco só exige unidade para `resident`);
    blocos e unidades vêm depois (T13). E-mail já cadastrado: usa a conta existente
    (req. 23); se ela já tem senha, o e-mail só avisa, sem link.
  - **Definir senha = mesmo fluxo do reset:** token em `password_resets`, link
    `WEB_ORIGIN/definir-senha#token=...` (7 dias), o web chama `POST /v1/auth/reset-password`.
    Sem tabela nem rota nova. Se o link vencer, "Esqueci minha senha".
  - `public_code`: 8 caracteres de `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (sem 0/O/1/I/L).
  - `npm run admin:criar` imprime o link de definir senha **no terminal** (24 h): o
    primeiro admin não depende de e-mail configurado.
  - Datas no contrato: `DateTime` em `src/schemas/common.ts` (ISO 8601 UTC).
- **Blocos, unidades e configurações (T13):**
  - Lista: `GET /v1/condominiums/:cid/blocks` → `{ items: [{ id, name, units: [{ id, number }] }] }`
    em ordem natural ("2" antes de "10"). Unidades não têm `GET` próprio. Tudo só síndico.
  - `PATCH /v1/condominiums/:cid`: só os campos enviados; corpo vazio → 400.
  - **Desligar `tenants_can_list_spots`** tira `can_list_spots` de todos os inquilinos já
    aprovados, na mesma transação (a configuração vale para todos, não só para os novos).
    Religar não devolve a permissão: o síndico concede de novo a quem quiser (T17).
  - **Apagar unidade (decisão adiada da T4):** só se nunca foi usada. Morador
    pendente/aprovado → 409 `UNIT_HAS_RESIDENTS`; já teve morador ou convite → 409
    `UNIT_HAS_HISTORY`. Sem soft delete nem cascata: o histórico (vínculos, convites e,
    depois, reservas) continua apontando para a unidade. Erro de digitação se corrige com
    `PATCH` (o morador continua na unidade). Reavaliar se surgir caso real de unidade
    que deixa de existir.
  - Apagar bloco com unidades → 409 `BLOCK_NOT_EMPTY`. Nome de bloco repetido no
    condomínio → 409 `BLOCK_NAME_TAKEN`; número repetido no bloco → 409 `UNIT_NUMBER_TAKEN`.
- **Acesso da portaria (T14):**
  - `PUT /v1/condominiums/:cid/front-desk { email, password }` → 200 `{ email }`. Mesmo
    e-mail da portaria atual: troca a senha. E-mail novo: o vínculo anterior vira
    `removed` e a conta nova entra aprovada, sem unidade, com nome "Portaria".
  - Em todos os casos, as sessões da portaria atual e da anterior são encerradas, links de
    redefinição pendentes deixam de valer e o bloqueio de login é desfeito.
  - **E-mail de outra conta → 409 `FRONT_DESK_EMAIL_IN_USE`:** o síndico não pode definir
    a senha da conta de um morador, de um admin ou da portaria de outro prédio. Só volta a
    ser aceito o e-mail que já foi da portaria deste condomínio e de nada mais.
  - `GET` (acréscimo ao contrato) → `{ email }`, ou `{ email: null }` sem acesso criado. A
    senha nunca volta.
  - A portaria acessa só rotas que a incluem (`GET /v1/condominiums/:cid` por enquanto);
    as rotas dela vêm no plano 005. Sessão de 30 dias (D5).
- **Troca de síndico (T15):**
  - Síndico: `POST /v1/condominiums/:cid/manager { membership_id }` (escolhe na lista de
    moradores). Admin: `POST /v1/admin/condominiums/:cid/manager { email }`, porque o admin
    não vê a lista de moradores. Os dois → 200
    `{ manager { user_id, name, email }, previous_manager { user_id, name, became } | null }`.
  - O destino precisa ser **morador aprovado** do condomínio: pendente, recusado, portaria
    ou o próprio síndico → 409 `NOT_APPROVED_RESIDENT`; de outro condomínio → 404
    `MEMBERSHIP_NOT_FOUND`. Ele mantém unidade e `can_list_spots`.
  - O síndico anterior vira morador da unidade dele (`became: "resident"`) e perde as
    permissões na hora, sem precisar de novo login. **Síndico sem unidade** (cadastrado
    pelo admin, T12) não pode ser morador: o vínculo vira `removed` (`became: "removed"`);
    se morar no condomínio, faz o cadastro pelo QR Code.
  - O admin também define um síndico quando não há nenhum (`previous_manager: null`).
  - Transação com trava no condomínio. Na troca pelo síndico, a API confere de novo,
    dentro da trava, se quem pediu ainda é o síndico (troca simultânea → 403). O índice
    `memberships_one_manager` garante um síndico aprovado no máximo.
  - O novo síndico recebe o aviso `manager_role_received` (sem aguardar o envio).
- **Cadastro pelo QR Code (T16):**
  - `GET /v1/public/condominiums/:code` → `{ name, blocks: [{ id, name, units: [{ id, number }] }] }`.
    Só nome e unidades: nada de endereço, síndico ou ids internos além das unidades. O
    código aceita minúsculas. Inexistente → 404 `CONDOMINIUM_NOT_FOUND`. 60/min por IP.
  - `POST /v1/public/condominiums/:code/signup { name, email, phone, password, unit_id, unit_relation }`
    → 201 `{ membership_id, status: "pending" }`. **Não faz login:** o app chama
    `POST /v1/auth/login` em seguida (assim o cookie do refresh fica só nas rotas de auth).
    Telefone guardado só com dígitos. 10/min por IP.
  - Unidade de outro condomínio → 404 `UNIT_NOT_FOUND`, sem criar a conta.
  - **E-mail já cadastrado → 409 `EMAIL_ALREADY_REGISTERED`.** Quem já tem conta (caso de
    borda: mesma pessoa em dois condomínios) entra e usa
    **`POST /v1/me/memberships { public_code, unit_id, unit_relation }`** (rota nova, com
    login), que cria o vínculo pendente com a conta atual. Já tem vínculo no condomínio
    (pendente, aprovado ou recusado) → 409 `ALREADY_MEMBER`; recusado reenvia pela T17.
  - O síndico recebe `membership_pending` com o link `WEB_ORIGIN/condominios/:cid/moradores`
    (caminho do web a confirmar). Sem síndico aprovado, ninguém é avisado.
- **Aprovação e permissões (T17):**
  - `GET /v1/condominiums/:cid/memberships?status=pending|approved|rejected` → `{ items }`,
    do mais novo ao mais antigo. Cada item: `id`, `role`, `status`, `unit_relation`,
    `can_list_spots`, `rejection_reason`, `created_at`, `decided_at`,
    `user { id, name, email, phone }` e `unit`. Inclui o síndico; **a portaria não
    aparece**. O síndico vê e-mail e telefone para falar com o morador antes de decidir.
  - `POST .../:id/approve { can_list_spots }` e `POST .../:id/reject { reason? }` → 204.
    Só cadastro **pendente** (senão 409 `INVALID_MEMBERSHIP_STATUS`); morador avisado
    nos dois casos. Recusar um aprovado não existe: isso é remoção (T20).
  - `PATCH .../:id { can_list_spots }` → 204, só para aprovados.
  - **Regra de inquilinos:** inquilino com `can_list_spots: true` e a regra do condomínio
    desligada → 409 `TENANTS_CANNOT_LIST_SPOTS`, ao aprovar e ao alterar. A linha do
    condomínio é travada (`for share`) para a regra não mudar no meio.
  - `PATCH .../memberships/me { unit_id?, unit_relation? }` → 204: o próprio morador,
    pendente ou recusado, corrige e reenvia; volta a pendente sem motivo nem
    `can_list_spots`, e o síndico é avisado de novo. Nome e telefone não mudam aqui
    (são da conta, valem para todos os condomínios); fica para uma rota de perfil.
  - Vários moradores na mesma unidade: aceitos (req. 19), sem regra extra.
- **Convites (T18):**
  - **Mudança de contrato: o token sai da URL.** A seção 4 previa
    `GET /v1/public/invites/:token` e `POST /v1/public/invites/:token/accept`, mas a URL
    de toda requisição vai para o log (princípio VI). Ficou como na T10: o link do web é
    `WEB_ORIGIN/convite#token=...` (fragmento) e a API recebe o token no corpo:
    `POST /v1/public/invites/lookup { token }` e
    `POST /v1/public/invites/accept { token, name, email, phone, password }`.
  - `POST /v1/condominiums/:cid/invites { unit_id, unit_relation, can_list_spots }` → 201
    com o convite e `invite_url` (só nesta resposta; o banco guarda o hash). Validade =
    `invite_validity_days` do condomínio, contada no banco. Regra de inquilinos igual à
    da aprovação (409 `TENANTS_CANNOT_LIST_SPOTS`).
  - `GET .../invites` → `{ items }` com `status` `pending` | `used` | `expired` | `revoked`
    e `used_by { id, name }`. `POST .../invites/:id/revoke` → 204; já usado ou cancelado
    → 409 `INVITE_NOT_REVOCABLE`. Vencido pode ser cancelado.
  - Convite que não vale: inexistente → 404 `INVITE_NOT_FOUND`; usado, vencido ou
    cancelado → **410** `INVITE_USED` / `INVITE_EXPIRED` / `INVITE_REVOKED`, todos com
    "Peça um novo convite ao síndico."
  - Aceite → 201 `{ membership_id, status: "approved", condominium }`, sem login
    automático (como na T16). Uso único pelo UPDATE condicional; quem perde a corrida
    recebe 410 e a transação desfaz a conta que tinha acabado de criar.
  - Se a regra de inquilinos foi desligada depois do convite, o inquilino entra sem poder
    anunciar (a permissão do convite não passa por cima da regra atual).
  - E-mail já cadastrado → 409 `EMAIL_ALREADY_REGISTERED`, e o convite continua valendo.
    Quem tem conta entra e usa **`POST /v1/me/invites/accept { token }`** (rota nova);
    já tem vínculo no condomínio → 409 `ALREADY_MEMBER`.
  - Rate limit: 30/min no lookup, 10/min no aceite, por IP.
- **Envio do convite pela plataforma (T19):**
  - `POST /v1/condominiums/:cid/invites/:id/send { channel: "email" | "whatsapp", recipient { name, email?, phone? } }`
    → 200 com o convite e o `invite_url` novo.
  - **O envio gera um link novo e o anterior deixa de valer.** A API guarda só o hash do
    token (D10), então não tem como reenviar o link original. Se o síndico já tinha
    compartilhado o link e depois pede o envio, vale o do e-mail.
  - O envio é **aguardado**: o síndico precisa saber se deu certo. Falha do fornecedor →
    **502** `INVITE_SEND_FAILED` ("tente de novo ou compartilhe o link"); tentar de novo
    gera outro link. O tratador de erros passou a repassar código e mensagem de erros do
    Vagou com 502/503; os demais 5xx continuam como `INTERNAL_ERROR`.
  - WhatsApp → 422 `CHANNEL_UNAVAILABLE` até a conta Meta existir; nada muda no convite.
    E-mail sem `recipient.email` → 400 `RECIPIENT_EMAIL_REQUIRED`.
  - Só convite pendente (409 `INVITE_NOT_SENDABLE`). O e-mail fica em
    `recipient_email`, que passou a aparecer na lista de convites. 20/min.
- **Remoção de morador (T20):**
  - `POST /v1/condominiums/:cid/memberships/:id/remove` → 204, só o síndico. Vale para
    morador pendente, aprovado ou recusado; o vínculo vira `removed`, perde a permissão de
    anunciar e some da lista. O morador pode se cadastrar de novo pelo QR Code (pendente).
  - O síndico não remove a si mesmo: 409 `CANNOT_REMOVE_MANAGER` (transfere o papel
    antes, T15). Portaria (tem rota própria, T14) e vínculo já removido → 404.
  - **Sessões:** a conta não é de um condomínio, as sessões também não. O acesso ao
    condomínio acaba no próximo request porque o vínculo é conferido a cada requisição.
    As sessões só são encerradas se o usuário ficar sem nenhum vínculo ativo (e não for
    admin); com vínculo em outro condomínio, ele continua logado lá.
  - **Evento `membership.removed`** `{ condominiumId, membershipId, userId, removedBy }`
    em `fastify.events` (`src/plugins/app/events.ts`). Os handlers rodam na mesma
    transação da remoção: se um falhar, a remoção é desfeita (500), para não ficar morador
    removido com vaga visível ou reserva ativa. Hoje não há consumidor; os planos 002 e
    006 registram os seus.
  - Trava a linha do condomínio, como a troca de síndico: remover e promover a síndico ao
    mesmo tempo não passam os dois.
  - Sem aviso ao morador removido: a spec não pede. Fácil de incluir se o produto quiser.
  - Bloco/unidade de outro condomínio → 404 `BLOCK_NOT_FOUND` / `UNIT_NOT_FOUND`.
- **Regra de senha nova (proposta, a confirmar):** 8 a 128 caracteres, sem exigir
  símbolo/maiúscula (NIST SP 800-63B). Já aplicada no reset (T10); entra também na T16.
