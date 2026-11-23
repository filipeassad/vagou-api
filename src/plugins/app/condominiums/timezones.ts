import createError from '@fastify/error';

// Só funções: o @fastify/autoload não registra este arquivo como plugin.
export const autoload = false;

export const InvalidTimezone = createError(
  'INVALID_TIMEZONE',
  'Fuso horário desconhecido. Use um nome IANA, como America/Sao_Paulo.',
  400,
);

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

/** Fuso do condomínio: nome IANA conhecido pelo Node (ex.: America/Sao_Paulo). */
export function assertValidTimezone(timezone: string): void {
  if (!TIMEZONES.has(timezone)) throw new InvalidTimezone();
}
