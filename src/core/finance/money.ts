/**
 * Utilidades de dinero en céntimos enteros (Regla 01 §2). Prohibido `Float`: todo importe es un entero.
 * Este archivo se amplía en el Sprint 1.2 con `eurosToCents` y `bpsOf`.
 */

export type MoneyLocale = 'es' | 'ca' | 'en';

/** `en` usa la convención irlandesa para que el euro salga delante (`€25.00`), como pide la Regla 03 §7. */
const INTL_LOCALE: Record<MoneyLocale, string> = { es: 'es-ES', ca: 'ca-ES', en: 'en-IE' };

/** Lanza si el importe no es un entero seguro: un importe con decimales delata un error de cálculo aguas arriba. */
export function assertSafeCents(cents: number, label = 'importe'): number {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`El ${label} debe ser un entero seguro en céntimos, recibido: ${String(cents)}`);
  }
  return cents;
}

const formatterCache = new Map<MoneyLocale, Intl.NumberFormat>();

function formatterFor(locale: MoneyLocale): Intl.NumberFormat {
  let formatter = formatterCache.get(locale);
  if (!formatter) {
    // `useGrouping: 'always'` evita que es-ES escriba 1000,00 € en lugar de 1.000,00 €.
    formatter = new Intl.NumberFormat(INTL_LOCALE[locale], {
      style: 'currency',
      currency: 'EUR',
      useGrouping: 'always',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    formatterCache.set(locale, formatter);
  }
  return formatter;
}

/**
 * Da formato a un importe en céntimos según el idioma: `2500` → `25,00 €` (es, ca) o `€25.00` (en).
 * Se pasa a `Intl` como cadena decimal exacta, sin dividir con coma flotante.
 */
export function formatCents(cents: number, locale: MoneyLocale): string {
  assertSafeCents(cents);
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const euros = Math.trunc(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  // Cadena decimal exacta: Intl la interpreta sin pasar por coma flotante (el tipo solo admite el literal `${number}`).
  const decimal = `${negative ? '-' : ''}${euros}.${fraction}` as `${number}`;
  return formatterFor(locale).format(decimal);
}
