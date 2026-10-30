import { createHash } from 'node:crypto';

/** Generador pseudoaleatorio determinista (mulberry32): la semilla produce siempre exactamente los mismos datos. */
export type Random = () => number;

export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Elige un elemento según sus pesos relativos. */
export function pickWeighted<T>(random: Random, options: ReadonlyArray<readonly [T, number]>): T {
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let threshold = random() * total;
  for (const [value, weight] of options) {
    threshold -= weight;
    if (threshold < 0) return value;
  }
  return options[options.length - 1]![0];
}

/**
 * Reparte `total` euros enteros en `count` importes de al menos `minEuros` cada uno, con forma realista (muchas
 * aportaciones pequeñas y algunas grandes) y suma EXACTA. Método del mayor resto, sin coma flotante en el resultado.
 */
export function splitEuros(random: Random, totalEuros: number, count: number, minEuros = 5): number[] {
  if (!Number.isInteger(totalEuros) || !Number.isInteger(count) || count <= 0) throw new RangeError('splitEuros necesita enteros positivos');
  if (totalEuros < count * minEuros) throw new RangeError(`No se pueden repartir ${totalEuros} € en ${count} importes de al menos ${minEuros} €`);

  const weights = Array.from({ length: count }, () => 0.35 + random() ** 2 * 2.4);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const distributable = totalEuros - count * minEuros;
  const raw = weights.map((weight) => (distributable * weight) / weightSum);
  const amounts = raw.map((value) => minEuros + Math.floor(value));
  let remainder = totalEuros - amounts.reduce((sum, amount) => sum + amount, 0);

  const byFraction = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; remainder > 0; i = (i + 1) % count) {
    amounts[byFraction[i]!.index]! += 1;
    remainder -= 1;
  }
  return amounts;
}

/** UUID v4 con aspecto aleatorio pero derivado de una clave: el mismo pase tiene siempre el mismo identificador. */
export function uuidFromKey(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '89ab'[parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

/** Número entero estable (32 bits) derivado de un texto, para sembrar un generador por iniciativa. */
export function seedFromText(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}
