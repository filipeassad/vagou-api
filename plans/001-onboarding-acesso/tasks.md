# Tarefas 001 — Onboarding e controle de acesso (API)

> Plano: [plan.md](plan.md). Uma tarefa por vez; cada uma termina com a verificação
> passando. Pré-requisito: Node 24 instalado e `npm run db:up` funcionando.

## Fundação

- [x] **T1. Configuração validada e logs seguros** (D13, D14)
      Schema TypeBox para variáveis de ambiente; `redact` no logger; `.env.example` atualizado.
      _Verificação:_ API não sobe sem `DATABASE_URL`/`JWT_SECRET` e mostra qual falta;
      teste confirma que `authorization` e `password` aparecem como `[Redacted]` no log.
      _Feito em 2026-11-22:_ `src/config/env.ts`, `src/config/logger.ts`, testes em
      `test/config/`. Usa o pacote `typebox` 1.x (o mesmo do plugin do Fastify).
      Reorganizado na estrutura do fastify/demo (`@fastify/autoload`, plano seção 2.1).

- [x] **T2. Banco: conexão Kysely + migrações** (D3)
      Plugin de banco no Fastify; scripts `db:migrate` e `db:rollback`; banco de teste separado.
      _Verificação:_ `npm run db:migrate` e `db:rollback` rodam sem erro; teste conecta no banco de teste.
      _Feito em 2026-11-22:_ `src/plugins/external/db.ts` (`fastify.db`), `scripts/migrate.ts`,
      `scripts/migrator.ts` (leitor de migrações próprio: o do Kysely falha com caminhos do
      Windows em ES Modules), `migrations/0001_extensions.ts` (citext, btree_gist),
      `test/global-setup.ts` cria e migra o `vagou_test`. Postgres na porta **5433** (a 5432
      estava ocupada por outro projeto). `serviceApp` passou a ser registrado com
      `fastify-plugin`, como no fastify/demo, para `fastify.db` ser visível na raiz.

- [x] **T3. Contrato OpenAPI** (D1, D2)
      TypeBox type provider, `@fastify/swagger`, Swagger UI só em desenvolvimento,
      script `npm run openapi:export` gerando `openapi.json`; formato padrão de erro.
      _Verificação:_ `GET /v1/openapi.json` responde; `openapi.json` gerado contém `/v1/health`.
      _Feito em 2026-11-22:_ `src/plugins/external/swagger.ts` (OpenAPI 3.1; `/docs` só com
      `NODE_ENV=development`), `src/routes/v1/index.ts` (`/v1/openapi.json`),
      `scripts/export-openapi.ts`, `src/schemas/common.ts` (`ErrorResponse`), error handler e
      404 em `src/app.ts`. Erros de negócio usam `@fastify/error`. Testes em `test/app.test.ts`
      e `test/routes/v1/openapi.test.ts`.

- [x] **T4. Migração do modelo de dados** (seção 3)
      Tabelas `users`, `condominiums`, `blocks`, `units`, `memberships`, `invites`,
      `sessions`, `password_resets`, com índices únicos parciais; gerar os tipos com
      `kysely-codegen`.
      _Verificação:_ teste tenta inserir dois síndicos aprovados no mesmo condomínio e o banco recusa.
      _Feito em 2026-11-22:_ `migrations/0002_onboarding.ts`; tipos em
      `src/plugins/external/db-types.ts` (`npm run db:codegen`, config em
      `.kysely-codegenrc.json`). `test/migrations/0002-onboarding.test.ts` cobre síndico e
      portaria únicos, um vínculo ativo por usuário, unidade/bloco de outro condomínio,
      e-mail repetido com maiúsculas e unidade repetida no bloco. `resetDatabase()` limpa o
      banco entre testes; arquivos de teste rodam em sequência. `users.phone` aceita null
      (portaria), ver notas da seção 3 do plano.

## Autenticação e sessão

- [x] **T5. Hash de senha e repositório de usuários** (D4)
      _Verificação:_ teste: senha correta valida, errada não; hash nunca igual à senha; e-mail
      duplicado (maiúsculas/minúsculas) é recusado (req. 23).
      _Feito em 2026-11-22:_ `src/plugins/app/auth/password-manager.ts` (`fastify.passwordManager`,
      Argon2id m=19456,t=2,p=1 via `@node-rs/argon2`) e `src/plugins/app/users/users-repository.ts`
      (`fastify.usersRepository`: `create`, `findById`, `findCredentialsByEmail`). E-mail
      repetido → erro `EMAIL_ALREADY_REGISTERED` (409). `findById` e `create` nunca devolvem o
      hash; só `findCredentialsByEmail` (usado pelo login) devolve.

- [x] **T6. Login com bloqueio por tentativas** (req. 20, 22; D7)
      _Verificação:_ testes: login correto devolve tokens; 5 erros bloqueiam por 15 min com
      mensagem genérica; rate limit por IP responde 429.
      _Feito em 2026-11-23:_ `POST /v1/auth/login` (`src/routes/v1/auth/index.ts`),
      `src/plugins/app/auth/auth-service.ts` (regras), `sessions-repository.ts`,
      `opaque-token.ts`, `memberships/memberships-repository.ts` (portaria = sessão de 30 dias),
      plugins `external/jwt.ts`, `cookie.ts`, `rate-limit.ts`. Access token só com `sub` e
      `sid` (ver seção 10 do plano). Imports relativos passaram a usar `.ts` (CLAUDE.md).

- [x] **T7. Sessões: access JWT + refresh com rotação e detecção de reuso** (D5, D6)
      Rotas `/v1/auth/refresh` e `/v1/auth/logout`; cookie `HttpOnly` ou corpo.
      _Verificação:_ testes: refresh gera novo par e invalida o anterior; reusar um refresh
      antigo derruba **todas** as sessões do usuário; logout invalida a sessão.
      _Feito em 2026-11-23:_ `refresh` e `logout` em `src/routes/v1/auth/index.ts`; regras em
      `auth-service.ts` (`refresh`, `logout`); `sessions-repository.ts` (`rotate` em
      transação com UPDATE condicional, `revoke`, `revokeAllForUser`). Web manda sem corpo
      (cookie); mobile manda `{ refresh_token }`. Janela de tolerância de 10 s para duas
      trocas quase juntas (duas abas) não derrubarem tudo; depois dela, reuso encerra todas
      as sessões e gera log `warn`. Refresh renova a validade (90/30 dias a partir da troca).

- [x] **T8. Plugin de autorização e isolamento por condomínio** (D8, seção 5; req. 15, 26)
      _Verificação:_ testes: morador do condomínio A recebe 404 em rota do condomínio B;
      vínculo pendente recebe 403 em rota de morador aprovado; síndico acessa rota de síndico,
      morador não.
      _Feito em 2026-11-23:_ `src/plugins/app/authorization.ts` (`fastify.authenticate`,
      `fastify.authorizeCondominium`, `ACCESS`), `src/routes/v1/condominiums/autohooks.ts`.
      `authenticate` confere também se a sessão está ativa (logout corta na hora).
      Adiantado da T13: `GET /v1/condominiums/:cid` (qualquer vínculo aprovado) e
      `condominiums-repository.ts`. Erros: `UNAUTHENTICATED` 401, `CONDOMINIUM_NOT_FOUND`
      404, `MEMBERSHIP_PENDING`/`MEMBERSHIP_REJECTED`/`FORBIDDEN` 403. Fixtures de teste em
      `test/fixtures.ts`. Teste de mutação: tirar o filtro de condomínio faz o teste falhar.

- [x] **T9. Notificador** (D9)
      Interface + implementação `console` (dev/teste) + esqueleto `email` (fornecedor a definir).
      _Verificação:_ teste captura a notificação enviada pelo notificador de teste.
      _Feito em 2026-11-23:_ `fastify.notifier` (`src/plugins/app/notifications/`), escolhido
      por `NOTIFIER`: `console` (padrão em desenvolvimento, imprime assunto e link no log, sem
      o e-mail), `memory` (testes; `sentNotifications(app)` em `test/helper.ts`) e `email`
      (esqueleto: `createEmailNotifier` + interface `EmailTransport`; a API não sobe com
      `email` até o fornecedor ser integrado). Em produção a config exige `NOTIFIER=email` e
      `EMAIL_FROM`. Tipos e textos (pt-BR) das notificações do plano em `messages.ts`.

- [x] **T10. Esqueci/redefinir senha** (req. 21; D10)
      _Verificação:_ testes: resposta igual para e-mail existente e inexistente; token vence em
      30 min e é de uso único; redefinir revoga todas as sessões.
      _Feito em 2026-11-23:_ `POST /v1/auth/forgot-password` (sempre 202) e
      `POST /v1/auth/reset-password` (204; erro 400 `INVALID_RESET_TOKEN`).
      `password-resets-repository.ts` e `password-reset-service.ts` em `plugins/app/auth/`.
      Link `WEB_ORIGIN/redefinir-senha#token=...` (token no fragmento). Só o link mais
      recente vale; no máximo 1 e-mail por minuto por conta; envio não aguardado. A troca
      (token usado + senha + desbloqueio + sessões encerradas) é uma transação. Teste de
      mutação: tirar a checagem de `used_at` faz 3 testes falharem.

- [x] **T11. `GET /v1/me`**
      _Verificação:_ teste devolve usuário e vínculos sem `senha_hash` nem dados de outros usuários.
      _Feito em 2026-11-23:_ `src/routes/v1/me/index.ts` (só exige login: serve também para
      vínculo pendente/recusado), `listForUser` em `memberships-repository.ts`, schema em
      `src/schemas/me.ts`. Vínculos removidos não aparecem. Teste de mutação: tirar o filtro
      de usuário faz o teste falhar.

## Condomínio e síndico

- [x] **T12. Admin: script de criação e cadastro de condomínio + síndico** (req. 1; D11)
      `npm run admin:criar`; `POST/GET /v1/admin/condominiums`; e-mail para o síndico definir a senha.
      _Verificação:_ teste: admin cria condomínio e síndico; síndico define senha pelo link e loga;
      usuário comum recebe 403 em `/v1/admin/*`.
      _Feito em 2026-11-23:_ `npm run admin:criar -- --name ... --email ...`
      (`scripts/create-admin.ts` + `plugins/app/admin/admin-bootstrap.ts`): cria ou promove
      e imprime no terminal o link de definir senha (24 h). `routes/v1/admin/autohooks.ts`
      (`authenticate` + `requireAdmin`), `admin-service.ts`, `createWithManager` e
      `listForAdmin` em `condominiums-repository.ts`. Condomínio + síndico + vínculo + link
      numa transação; `public_code` de 8 caracteres sem ambíguos (tenta de novo se colidir).
      O link de definir senha usa `password_resets` (7 dias) e o mesmo `reset-password`.
      E-mail já cadastrado reaproveita a conta. Teste de mutação no `requireAdmin` ok.

- [x] **T13. Síndico mantém dados, blocos, unidades e configurações** (req. 2, 3, 13)
      _Verificação:_ testes: CRUD de blocos/unidades; unidade duplicada no bloco é recusada;
      não é possível apagar unidade com moradores aprovados; configurações salvas.
      _Feito em 2026-11-23:_ `PATCH /v1/condominiums/:cid`; blocos com GET, POST, PATCH e
      DELETE em `.../blocks`; unidades com POST, PATCH e DELETE em `.../units` (só síndico).
      `blocks-repository.ts`, `units-repository.ts`, `update` em `condominiums-repository.ts`,
      `timezones.ts` (compartilhado com o admin). Apagar unidade: só se nunca usada
      (`UNIT_HAS_RESIDENTS` / `UNIT_HAS_HISTORY`, 409). Desligar inquilinos tira
      `can_list_spots` dos inquilinos aprovados. Teste de mutação no filtro de condomínio ok.

- [x] **T14. Acesso da portaria** (req. 4; D12)
      _Verificação:_ teste: síndico cria acesso; portaria loga; portaria recebe 403 em rotas de
      morador/síndico; recriar o acesso derruba as sessões anteriores da portaria; o refresh
      da portaria vence em 30 dias (D5).
      _Feito em 2026-11-23:_ `GET` e `PUT /v1/condominiums/:cid/front-desk` (só síndico).
      Mesmo e-mail troca a senha; e-mail novo substitui o acesso (o anterior vira `removed`).
      Sessões da portaria atual e anterior caem. E-mail de outra conta → 409
      `FRONT_DESK_EMAIL_IN_USE`. Teste de mutação na revogação das sessões ok.

- [x] **T15. Troca de síndico** (req. 5)
      _Verificação:_ testes: síndico atual e admin conseguem passar o papel; o anterior vira
      morador aprovado; nunca existem dois síndicos aprovados.
      _Feito em 2026-11-23:_ `POST /v1/condominiums/:cid/manager { membership_id }` e
      `POST /v1/admin/condominiums/:cid/manager { email }`. Destino precisa ser morador
      aprovado (409 `NOT_APPROVED_RESIDENT`). Síndico sem unidade perde o vínculo
      (`removed`). Novo síndico recebe aviso. Teste de mutação no filtro de condomínio ok.

## Cadastro e aprovação

- [x] **T16. Cadastro público pelo QR Code** (req. 6–9)
      _Verificação:_ testes: `GET` devolve só blocos/unidades daquele condomínio; cadastro cria
      vínculo pendente e notifica o síndico; unidade de outro condomínio é recusada; código
      inexistente → 404.
      _Feito em 2026-11-23:_ `GET /v1/public/condominiums/:code`,
      `POST /v1/public/condominiums/:code/signup` (201, sem login automático) e, para quem já
      tem conta, `POST /v1/me/memberships`. E-mail já cadastrado → 409. Teste de mutação no
      filtro de condomínio da unidade ok.

- [x] **T17. Aprovar, recusar, reenviar e permissão de anunciar** (req. 15–19)
      _Verificação:_ testes: aprovação notifica o morador; com `tenants_can_list_spots = false`,
      aprovar inquilino com `can_list_spots = true` é recusado; recusa com motivo notifica;
      morador corrige e volta para pendente; dois moradores na mesma unidade são aceitos.
      _Feito em 2026-11-23:_ `GET .../memberships?status=`, `POST .../:id/approve`,
      `POST .../:id/reject`, `PATCH .../:id` (permissão de anunciar) e `PATCH .../memberships/me`
      (morador reenvia). Testes de mutação na regra de inquilinos e no filtro de condomínio ok.

- [x] **T18. Convites: gerar, listar, revogar, aceitar** (req. 10, 12–14, 17)
      _Verificação:_ testes: convite aceito cria vínculo aprovado na unidade certa; segundo uso
      é recusado; **duas aceitações simultâneas → só uma vence**; expirado e revogado são
      recusados com motivo; validade segue a configuração do condomínio (padrão 7 dias).
      _Feito em 2026-11-23:_ `POST`/`GET .../invites`, `POST .../invites/:id/revoke`,
      `POST /v1/public/invites/lookup` e `/accept` (token no corpo, não na URL) e
      `POST /v1/me/invites/accept` para quem já tem conta. Teste de mutação na condição de uso
      único ok (pega pela corrida de três contas logadas).

- [x] **T19. Envio do convite pela plataforma (e-mail)** (req. 11)
      _Verificação:_ teste: `send` com canal `email` chama o notificador com o link; canal
      `whatsapp` responde "indisponível" até a integração Meta existir.
      _Feito em 2026-11-23:_ `POST .../invites/:id/send { channel, recipient { name, email? } }`.
      Gera um link novo (o anterior deixa de valer) e aguarda o envio; falha do fornecedor →
      502 `INVITE_SEND_FAILED`. WhatsApp → 422 `CHANNEL_UNAVAILABLE`. Teste de mutação ok.

- [x] **T20. Remoção de morador** (req. 24, 25)
      Status `removed`, revoga todas as sessões do usuário no condomínio, emite `membership.removed`.
      _Verificação:_ teste: após remover, o próximo request do morador com access token ainda
      válido recebe 404/403 (vínculo conferido a cada requisição); evento emitido.
      _Feito em 2026-11-23:_ `POST .../memberships/:id/remove` → 204. Sessões encerradas só se
      o usuário ficar sem vínculo ativo; com vínculo em outro condomínio, recebe 404 aqui e
      segue logado lá. Evento em `fastify.events`, na mesma transação. Síndico → 409
      `CANNOT_REMOVE_MANAGER`. Teste de mutação ok (sessões e evento).

## Fechamento

- [x] **T21. Exportar contrato e pedir revisão do web**
      `npm run openapi:export`; commit do `openapi.json`.
      _Verificação:_ `openapi.json` lista todas as rotas da seção 4 do plano.
      _Feito em 2026-11-23:_ 31 caminhos; todas as rotas da seção 4 estão no contrato, conferido
      nos dois sentidos (a tabela ganhou as que faltavam: `GET .../blocks`,
      `GET .../front-desk`, `POST /v1/me/memberships`, `POST /v1/me/invites/accept`). Pedido
      de revisão na seção 9 do plano (itens 4 a 9), com um problema achado: o proxy do Vite
      e o caminho do cookie do refresh. Teste `test/routes/v1/openapi.test.ts` passou a
      conferir a lista de rotas.

- [ ] **T22. Validação dos critérios de aceite da spec 001 (lado API)**
      Teste de ponta a ponta por cenário da spec (via `app.inject`).
      _Verificação:_ todos os cenários da spec passam; atualizar a coluna **API** da
      tabela em `vagou-specs/specs/README.md` para "Implementada".
