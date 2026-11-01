import { createHash, randomInt } from 'node:crypto';

/**
 * Parte pura del sorteo certificado (skill korum-ticketing-qr §4). Solo `crypto.randomInt`, y un acta que cualquiera puede volver a comprobar:
 * la lista de papeletas participantes, su huella y el resultado. No lleva datos personales.
 */

export interface RaffleEntry {
  number: number;
  serialCode: string;
}

export interface DrawAct {
  initiativeId: number;
  round: number;
  drawnAt: string;
  participantsSha256: string;
  participantCount: number;
  winningNumbers: number[];
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Lista canónica: siempre en el mismo orden y con las mismas claves, para que la huella no dependa de cómo se leyó. */
export function canonicalEntries(entries: readonly RaffleEntry[]): RaffleEntry[] {
  return [...entries].sort((a, b) => a.number - b.number).map(({ number, serialCode }) => ({ number, serialCode }));
}

export const hashEntries = (entries: readonly RaffleEntry[]): string => sha256(JSON.stringify(canonicalEntries(entries)));

export function hashAct(act: DrawAct): string {
  const { initiativeId, round, drawnAt, participantsSha256, participantCount, winningNumbers } = act;
  return sha256(JSON.stringify({ initiativeId, round, drawnAt, participantsSha256, participantCount, winningNumbers }));
}

/** Fisher-Yates parcial: cada papeleta tiene la misma probabilidad, y ninguna gana dos veces. Los ganadores salen en orden de extracción. */
export function pickWinners(numbers: readonly number[], count: number, random: (max: number) => number = randomInt): number[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > numbers.length) throw new RangeError('El número de premios debe estar entre 1 y el de papeletas.');
  const pool = [...numbers].sort((a, b) => a - b);
  for (let index = 0; index < count; index += 1) {
    const chosen = index + random(pool.length - index);
    [pool[index], pool[chosen]] = [pool[chosen]!, pool[index]!];
  }
  return pool.slice(0, count);
}

/** Comprueba un acta guardada: que la lista corresponde a su huella, que los ganadores estaban en ella y que nada se ha tocado. */
export function verifyDrawAct(act: DrawAct, entries: readonly RaffleEntry[], actSha256: string): boolean {
  const numbers = new Set(entries.map((entry) => entry.number));
  return hashEntries(entries) === act.participantsSha256 && entries.length === act.participantCount && act.winningNumbers.every((number) => numbers.has(number)) && hashAct(act) === actSha256;
}
