import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyAutoload from '@fastify/autoload';
import type { FastifyError, FastifyInstance } from 'fastify';
import type { Config } from './config/env.ts';
import { ErrorResponse } from './schemas/common.ts';

export type AppOptions = {
  config: Config;
};

/**
 * Monta a aplicação carregando as pastas automaticamente (padrão fastify/demo):
 * 1. plugins/external: infraestrutura de terceiros (banco, cors, swagger...)
 * 2. plugins/app: plugins do próprio Vagou (repositórios, serviços, autorização)
 * 3. routes: cada pasta vira um prefixo de URL (routes/v1/health → /v1/health)
 */
export default async function serviceApp(fastify: FastifyInstance, opts: AppOptions) {
  fastify.decorate('config', opts.config);

  // Schemas compartilhados: as rotas usam Type.Ref('ErrorResponse') e o OpenAPI
  // mostra cada um uma vez em components/schemas.
  fastify.addSchema(ErrorResponse);

  // Antes do autoload: plugins e rotas herdam os handlers no momento em que são registrados.
  fastify.setErrorHandler((err: FastifyError, request, reply) => {
    const body = toErrorResponse(err);
    const statusCode = err.validation ? 400 : (err.statusCode ?? 500);
    if (statusCode >= 500) {
      request.log.error({ err }, 'Erro não tratado');
    }
    return reply.code(statusCode).send(body);
  });

  fastify.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' },
    } satisfies ErrorResponse),
  );

  const folders = [
    { dir: 'plugins/external' },
    { dir: 'plugins/app' },
    // routeParams: pasta `_cid` vira o parâmetro `:cid` na URL.
    { dir: 'routes', autoHooks: true, cascadeHooks: true, routeParams: true },
  ];

  for (const { dir, ...autoloadOptions } of folders) {
    const fullPath = path.join(import.meta.dirname, dir);
    // O build (tsc) não copia pastas vazias para dist/; pula as que ainda não têm arquivos.
    if (!existsSync(fullPath)) continue;
    await fastify.register(fastifyAutoload, {
      dir: fullPath,
      // Arquivos *-types.ts só têm tipos (ex.: db-types.ts gerado pelo kysely-codegen).
      ignorePattern: /-types\.(ts|js)$/,
      ...autoloadOptions,
      options: { ...opts },
    });
  }
}

/** Mensagens genéricas para erros que não vieram do código do Vagou. */
const GENERIC_ERRORS: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'Requisição inválida.' },
  401: { code: 'UNAUTHORIZED', message: 'É preciso entrar na sua conta.' },
  403: { code: 'FORBIDDEN', message: 'Você não tem permissão para isso.' },
  404: { code: 'NOT_FOUND', message: 'Não encontrado.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Requisição grande demais.' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Formato de conteúdo não aceito.' },
  429: { code: 'RATE_LIMITED', message: 'Muitas tentativas. Aguarde um pouco e tente de novo.' },
};

/**
 * Converte qualquer erro para o formato padrão (schemas/common.ts).
 * - Validação de schema → 400 VALIDATION_ERROR com um item por campo.
 * - Erros do Vagou (criados com @fastify/error, código sem prefixo FST_) e status < 500
 *   → código e mensagem do próprio erro.
 * - Erros do Fastify/plugins (FST_*) → mensagem genérica em português pelo status.
 * - 5xx → nunca expõe detalhes internos. Exceção: erros do Vagou com 502/503 (fornecedor
 *   externo fora do ar), cuja mensagem foi escrita por nós e orienta o usuário.
 */
export function toErrorResponse(err: FastifyError): ErrorResponse {
  if (err.validation) {
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos.',
        details: err.validation.map((issue) => {
          const missing = (issue.params as { missingProperty?: unknown }).missingProperty;
          const field =
            typeof missing === 'string' ? `${issue.instancePath}/${missing}` : issue.instancePath;
          return { field: field || '/', message: issue.message ?? 'inválido' };
        }),
      },
    };
  }

  const statusCode = err.statusCode ?? 500;
  const isVagouError =
    typeof err.code === 'string' && /^[A-Z][A-Z_]+$/.test(err.code) && !err.code.startsWith('FST_');
  const upstreamFailure = statusCode === 502 || statusCode === 503;
  if (statusCode >= 500 && !(isVagouError && upstreamFailure)) {
    return {
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente em instantes.' },
    };
  }

  if (isVagouError) {
    return { error: { code: err.code, message: err.message } };
  }
  return { error: GENERIC_ERRORS[statusCode] ?? GENERIC_ERRORS[400]! };
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}
