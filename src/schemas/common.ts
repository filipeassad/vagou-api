import { Type, type Static } from 'typebox';

/**
 * Formato padrão de erro de toda a API:
 * { "error": { "code": "VALIDATION_ERROR", "message": "Dados inválidos.", "details": [...] } }
 *
 * - `code`: identificador estável em inglês (UPPER_SNAKE_CASE), para o cliente decidir o que fazer
 * - `message`: texto em português, pronto para mostrar ao usuário
 * - `details`: só em erros de validação, um item por campo com problema
 */
export const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String({ examples: ['VALIDATION_ERROR'] }),
      message: Type.String({ examples: ['Dados inválidos.'] }),
      details: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.String({ examples: ['/email'] }),
            message: Type.String(),
          }),
        ),
      ),
    }),
  },
  { $id: 'ErrorResponse', title: 'ErrorResponse' },
);

export type ErrorResponse = Static<typeof ErrorResponse>;

/**
 * Data/hora no contrato: texto ISO 8601 em UTC (restrições técnicas). No código é `Date`;
 * o serializador do Fastify converte com `toISOString()`.
 */
export const DateTime = Type.Unsafe<Date>(Type.String({ format: 'date-time' }));
