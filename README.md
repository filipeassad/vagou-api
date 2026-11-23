# vagou-api

API do Vagou: aluguel interno de vagas em condomínios.

## Pré-requisitos

- Node.js 24 LTS
- Docker (Postgres local)
- Repositório `vagou-specs` clonado ao lado deste (constituição e specs):

```
Vagou/
├── vagou-specs/
├── vagou-api/   ← este
└── vagou-web/
```

## Rodando

```bash
npm install
cp .env.example .env
# preencha JWT_SECRET no .env (comando para gerar está no próprio arquivo)
npm run db:up        # Postgres na porta 5433 (container vagou_db)
npm run db:migrate
npm run dev          # http://localhost:3333/v1/health
npm test             # cria e migra o banco vagou_test sozinho
npm run openapi:export  # gera o contrato openapi.json
```
