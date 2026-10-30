import { describe, expect, it } from 'vitest';
import { assertSafeCents, bpsOf, formatCents, MoneyParseError, parseEurosToCents } from '@/core/finance/money';

/** Generador pseudoaleatorio determinista (mulberry32): mismas 1.000 combinaciones en cada ejecución. */
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('parseEurosToCents · importes escritos por personas', () => {
  it('lee el formato de cada idioma', () => {
    expect(parseEurosToCents('25', 'es')).toBe(2_500);
    expect(parseEurosToCents('25,5', 'es')).toBe(2_550);
    expect(parseEurosToCents('1.234,56 €', 'es')).toBe(123_456);
    expect(parseEurosToCents('1.234.567,89', 'ca')).toBe(123_456_789);
    expect(parseEurosToCents('€1,234.56', 'en')).toBe(123_456);
    expect(parseEurosToCents('0.05', 'en')).toBe(5);
  });

  it('en castellano y catalán acepta «25.50» con punto como decimal (teclado del móvil)', () => {
    expect(parseEurosToCents('25.50', 'es')).toBe(2_550);
    expect(parseEurosToCents('25.5', 'ca')).toBe(2_550);
    expect(parseEurosToCents('1.234', 'es')).toBe(123_400);
    expect(parseEurosToCents('25,5', 'en')).toBe(2_550);
  });

  it('tolera espacios, espacio duro, símbolo del euro y signo negativo', () => {
    expect(parseEurosToCents(' 1 234,56 € ', 'es')).toBe(123_456);
    expect(parseEurosToCents('-0,34', 'es')).toBe(-34);
    expect(parseEurosToCents('−0,34', 'es')).toBe(-34);
    expect(Object.is(parseEurosToCents('-0', 'es'), 0)).toBe(true);
  });

  it('rechaza lo que no es un importe exacto en céntimos', () => {
    for (const [input, locale] of [
      ['', 'es'],
      ['€', 'es'],
      ['12,345', 'es'],
      ['1.23.45', 'es'],
      ['12a', 'es'],
      ['1,2,3', 'en'],
      ['99999999999999999999', 'es']
    ] as const) {
      expect(() => parseEurosToCents(input, locale), input).toThrow(MoneyParseError);
    }
  });

  it('ida y vuelta con formatCents en los tres idiomas (1.000 importes con semilla fija)', () => {
    const random = seededRandom(20261030);
    for (let i = 0; i < 1_000; i += 1) {
      const cents = Math.floor(random() * 1_000_000_000);
      for (const locale of ['es', 'ca', 'en'] as const) {
        expect(parseEurosToCents(formatCents(cents, locale), locale)).toBe(cents);
      }
    }
  });
});

describe('bpsOf · porcentajes en puntos básicos', () => {
  it('calcula comisiones de la Regla 02 al céntimo', () => {
    expect(bpsOf(2_500, 100)).toBe(25);
    expect(bpsOf(25_000, 1_500)).toBe(3_750);
    expect(bpsOf(400_000, 400)).toBe(16_000);
    expect(bpsOf(555, 100)).toBe(6);
  });

  it('redondea la mitad alejándose de cero y es simétrico', () => {
    expect(bpsOf(50, 100)).toBe(1);
    expect(bpsOf(49, 100)).toBe(0);
    expect(bpsOf(-50, 100)).toBe(-1);
    expect(bpsOf(-49, 100)).toBe(0);
    expect(bpsOf(150, -100)).toBe(-2);
  });

  it('coincide con Math.round de las fórmulas TCO en 1.000 combinaciones (semilla fija)', () => {
    const random = seededRandom(42);
    for (let i = 0; i < 1_000; i += 1) {
      const amount = Math.floor(random() * 10_000_000);
      const bps = Math.floor(random() * 2_500);
      expect(bpsOf(amount, bps), `${amount} × ${bps}`).toBe(Math.round((amount * bps) / 10_000));
    }
  });

  it('es exacto donde la coma flotante fallaría y avisa si el resultado no cabe', () => {
    expect(bpsOf(Number.MAX_SAFE_INTEGER, 10_000)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => bpsOf(Number.MAX_SAFE_INTEGER, 20_000)).toThrow(RangeError);
    expect(() => bpsOf(1.5, 100)).toThrow(RangeError);
    expect(() => bpsOf(100, 1.5)).toThrow(RangeError);
  });
});

// Intl separa la cifra del símbolo con un espacio duro (U+00A0); los textos esperados lo reflejan.
const NBSP = ' ';

describe('formatCents · importes por idioma', () => {
  it('formatea en castellano y catalán con coma decimal y el euro detrás', () => {
    expect(formatCents(2500, 'es')).toBe(`25,00${NBSP}€`);
    expect(formatCents(2500, 'ca')).toBe(`25,00${NBSP}€`);
  });

  it('formatea en inglés con el euro delante y punto decimal', () => {
    expect(formatCents(2500, 'en')).toBe('€25.00');
  });

  it('agrupa miles también en castellano con 4 cifras (1.000,00 €, no 1000,00 €)', () => {
    expect(formatCents(100_000, 'es')).toBe(`1.000,00${NBSP}€`);
    expect(formatCents(100_000, 'en')).toBe('€1,000.00');
    expect(formatCents(12_345_678, 'es')).toBe(`123.456,78${NBSP}€`);
  });

  it('muestra siempre dos decimales, incluido el cero limpio', () => {
    expect(formatCents(0, 'es')).toBe(`0,00${NBSP}€`);
    expect(formatCents(5, 'es')).toBe(`0,05${NBSP}€`);
    expect(formatCents(34, 'en')).toBe('€0.34');
  });

  it('formatea importes negativos sin perder el céntimo', () => {
    expect(formatCents(-34, 'es')).toBe(`-0,34${NBSP}€`);
    expect(formatCents(-100_034, 'en')).toBe('-€1,000.34');
  });

  it('es exacto en los extremos donde la coma flotante fallaría', () => {
    expect(formatCents(Number.MAX_SAFE_INTEGER, 'en')).toBe('€90,071,992,547,409.91');
    expect(formatCents(1_000_000_000_001, 'en')).toBe('€10,000,000,000.01');
  });

  it('rechaza importes que no son enteros seguros', () => {
    expect(() => formatCents(12.5, 'es')).toThrow(RangeError);
    expect(() => formatCents(Number.NaN, 'es')).toThrow(RangeError);
    expect(() => formatCents(Number.MAX_SAFE_INTEGER + 1, 'es')).toThrow(RangeError);
  });
});

describe('assertSafeCents', () => {
  it('devuelve el mismo valor si es un entero seguro', () => {
    expect(assertSafeCents(0)).toBe(0);
    expect(assertSafeCents(-250)).toBe(-250);
  });

  it('incluye el nombre del importe en el error', () => {
    expect(() => assertSafeCents(0.1, 'fee de Hucha')).toThrow(/fee de Hucha/);
  });
});
