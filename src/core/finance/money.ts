/**
 * Utilidades de dinero en céntimos enteros (Regla 01 §2). Prohibido `Float`: todo importe es un entero en céntimos y todo
 * porcentaje un entero en puntos básicos (`100` = `1,00 %`). Las operaciones que podrían desbordar usan `BigInt`.
 */

export type MoneyLocale = 'es' | 'ca' | 'en';

export class MoneyParseError extends Error {
  constructor(input: string, reason: string) {
    super(`Importe no válido «${input}»: ${reason}`);
    this.name = 'MoneyParseError';
  }
}

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

const SEPARATORS: Record<MoneyLocale, { decimal: string; group: string }> = {
  es: { decimal: ',', group: '.' },
  ca: { decimal: ',', group: '.' },
  en: { decimal: '.', group: ',' }
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Convierte a céntimos un importe escrito por una persona, sin coma flotante: «25», «25,5», «1.234,56 €», «€1,234.56».
 * - Separadores del idioma: coma decimal y punto de miles en `es`/`ca`; al revés en `en`.
 * - Tolerancia habitual en el móvil: un único separador de miles seguido de 1 o 2 cifras se lee como decimal («25.50» en
 *   `es`/`ca`, «25,5» en `en`), porque nadie escribe miles con menos de 3 cifras.
 * - Rechaza más de 2 decimales, grupos de miles mal formados, texto vacío o importes que no caben en un entero seguro.
 */
export function parseEurosToCents(input: string, locale: MoneyLocale): number {
  const { decimal, group } = SEPARATORS[locale];
  let text = input.replace(/[€\s  ]/g, '').replace(/^−/, '-');
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);
  if (text === '') throw new MoneyParseError(input, 'está vacío');

  const lastDecimal = text.lastIndexOf(decimal);
  const groupCount = text.split(group).length - 1;
  let integerPart: string;
  let fractionPart = '';

  if (lastDecimal === -1 && groupCount === 1 && new RegExp(`^\\d+${escapeRegExp(group)}\\d{1,2}$`).test(text)) {
    // Un único separador de miles seguido de 1–2 cifras: la persona ha usado el otro separador decimal.
    [integerPart, fractionPart] = text.split(group) as [string, string];
  } else {
    if (lastDecimal !== -1) {
      fractionPart = text.slice(lastDecimal + 1);
      integerPart = text.slice(0, lastDecimal);
      if (!/^\d{1,2}$/.test(fractionPart)) throw new MoneyParseError(input, 'admite como máximo 2 decimales');
    } else {
      integerPart = text;
    }
    if (integerPart.includes(group)) {
      const grouped = new RegExp(`^\\d{1,3}(${escapeRegExp(group)}\\d{3})+$`);
      if (!grouped.test(integerPart)) throw new MoneyParseError(input, 'separador de miles mal colocado');
      integerPart = integerPart.split(group).join('');
    }
  }

  if (!/^\d+$/.test(integerPart)) throw new MoneyParseError(input, 'solo puede contener cifras y separadores');
  const cents = BigInt(integerPart) * 100n + BigInt(fractionPart.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyParseError(input, 'es demasiado grande');
  return negative && cents !== 0n ? -Number(cents) : Number(cents);
}

/**
 * Porcentaje en puntos básicos de un importe en céntimos (`bpsOf(2500, 100)` = `25`), redondeado al céntimo con la mitad
 * alejándose de cero. Para importes positivos coincide con `Math.round(importe × bps / 10000)` de las fórmulas TCO, pero sin
 * riesgo de desbordar ni de error de coma flotante, y es simétrico para importes negativos.
 */
export function bpsOf(amountCents: number, bps: number): number {
  assertSafeCents(amountCents);
  if (!Number.isSafeInteger(bps)) throw new RangeError(`Los puntos básicos deben ser un entero, recibido: ${String(bps)}`);
  const product = BigInt(amountCents) * BigInt(bps);
  const magnitude = product < 0n ? -product : product;
  const rounded = (magnitude + 5000n) / 10000n;
  const result = product < 0n ? -rounded : rounded;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('El resultado no cabe en un entero seguro de céntimos');
  }
  return Number(result);
}
