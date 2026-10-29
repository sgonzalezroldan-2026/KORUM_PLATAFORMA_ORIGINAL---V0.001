import { describe, expect, it } from 'vitest';
import { assertSafeCents, formatCents } from '@/core/finance/money';

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
