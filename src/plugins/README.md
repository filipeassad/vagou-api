# Plugins

Carregados automaticamente pelo `@fastify/autoload` em `src/app.ts`, nesta ordem:

1. **`external/`**: integração com bibliotecas de terceiros, um arquivo por
   plugin (ex.: `db.ts` com Kysely, `swagger.ts`, `rate-limit.ts`, `jwt.ts`).
2. **`app/`**: plugins do próprio Vagou: repositórios, serviços e autorização.
   Agrupar por assunto em subpastas (ex.: `app/invites/invites-repository.ts`).

Plugins que precisam ser vistos pelo resto da aplicação (ex.: `fastify.db`)
DEVEM ser envolvidos com `fastify-plugin` (`fp`), para não ficarem encapsulados.
