/**
 * Qué le dice el pase de una rifa a quien lo abre (Sprint 5.9): si ya hubo sorteo y si alguno de sus números ha salido. Es una función pura sobre las
 * actas ya publicadas (solo números de papeleta, nunca personas): lo mismo que se proyecta en la fiesta.
 *
 * Un número «sigue ganando» si salió en alguna ronda y ninguna ronda extra lo sustituyó después (premio sin reclamar o ganador reembolsado).
 */

export interface RaffleDrawFact {
  winningNumbers: readonly number[];
  /** Solo en una ronda extra: los números ganadores que sustituye. */
  replacedNumbers: readonly number[];
  /** `true` en una ronda extra de los firmantes. */
  extra: boolean;
}

export type RafflePassOutcome =
  | { state: 'NOT_DRAWN' }
  /** El sorteo ha empezado pero aún quedan premios por sortear y ninguno de sus números ha salido. */
  | { state: 'IN_PROGRESS' }
  /** Alguno de sus números sigue siendo ganador. */
  | { state: 'WON'; numbers: number[] }
  /** Salió alguno de sus números, pero ese premio se volvió a sortear y ninguno otro le ha tocado. */
  | { state: 'REPLACED'; numbers: number[] }
  /** El sorteo está completo y ninguno de sus números ha salido. */
  | { state: 'NOT_WON' };

function ascending(numbers: Iterable<number>): number[] {
  return [...numbers].sort((first, second) => first - second);
}

export function raffleOutcomeForPass(input: { numbers: readonly number[]; prizeCount: number | null; draws: readonly RaffleDrawFact[] }): RafflePassOutcome {
  if (input.draws.length === 0) return { state: 'NOT_DRAWN' };

  const replaced = new Set(input.draws.flatMap((draw) => draw.replacedNumbers));
  const standing = new Set(input.draws.flatMap((draw) => draw.winningNumbers).filter((value) => !replaced.has(value)));
  const own = new Set(input.numbers);

  const won = ascending([...own].filter((value) => standing.has(value)));
  if (won.length > 0) return { state: 'WON', numbers: won };

  const replacedOwn = ascending([...own].filter((value) => replaced.has(value)));
  if (replacedOwn.length > 0) return { state: 'REPLACED', numbers: replacedOwn };

  const drawnPrizes = input.draws.filter((draw) => !draw.extra).reduce((sum, draw) => sum + draw.winningNumbers.length, 0);
  return input.prizeCount !== null && drawnPrizes < input.prizeCount ? { state: 'IN_PROGRESS' } : { state: 'NOT_WON' };
}
