/**
 * Límites de la votación de redimensionamiento (Sprint 4.4b) que comparten el servidor y el formulario del panel. Sin dependencias de servidor: este
 * archivo llega al navegador.
 */

export const RESIZE_POLL_DAYS = 7;
/**
 * Días de la ventana de 90 de Paycomet que hacen falta para lanzar la votación: los 7 de votar más 10 para pedir la liquidación y que firmen las dos
 * personas, y 1 de margen (la ventana se cuenta aquí desde la confirmación del primer cobro y el reparto, desde que empezó su pago: auditoría financiera
 * del 4.4b, H6). Con menos, solo se puede reembolsar (los repartos fuera de la ventana no salen).
 */
export const RESIZE_MIN_WINDOW_DAYS = RESIZE_POLL_DAYS + 11;
export const RESIZE_OPTIONS_MIN = 2;
export const RESIZE_OPTIONS_MAX = 4;
export const RESIZE_OPTION_MIN_LENGTH = 10;
export const RESIZE_OPTION_MAX_LENGTH = 160;

/** Dos opciones que solo se distinguen en mayúsculas o espacios son la misma: partirían el voto sin que nadie lo note. */
export function hasDuplicateOptions(options: readonly string[]): boolean {
  const keys = options.map((option) => option.toLocaleLowerCase('es').replace(/\s+/g, ' ').trim());
  return new Set(keys).size !== keys.length;
}
