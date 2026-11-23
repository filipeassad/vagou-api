# Rotas

Carregadas automaticamente pelo `@fastify/autoload` em `src/app.ts`. O caminho
da pasta vira o prefixo da URL:

| Arquivo                                                | URL                   |
| ------------------------------------------------------ | --------------------- |
| `routes/v1/health/index.ts` com `fastify.get('/')`     | `GET /v1/health`      |
| `routes/v1/auth/index.ts` com `fastify.post('/login')` | `POST /v1/auth/login` |

- Cada `index.ts` exporta um plugin (função `async (fastify) => {}`) com as rotas da pasta.
- Hooks aplicados a uma pasta inteira (ex.: exigir login) ficam em `autohooks.ts`
  nessa pasta e valem para as subpastas.
- Pastas com `_` viram parâmetros: `routes/v1/condominiums/_cid/index.ts` →
  `/v1/condominiums/:cid`.
- Tudo dentro de `routes/v1/condominiums/` exige login e vínculo com o `:cid`
  (`autohooks.ts`). A rota escolhe quem pode com `config.access` (ver CLAUDE.md).
- Schemas de entrada e saída ficam em `src/schemas/` (TypeBox).
- Regras de negócio e acesso ao banco NÃO ficam aqui: ficam em `src/plugins/app/`.
