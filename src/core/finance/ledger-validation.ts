import type { LedgerDirection } from '@/generated/prisma/enums';
import { ACCOUNT_RULES, MAX_IDEMPOTENCY_KEY_LENGTH, type JournalLine, type PostJournalInput } from './ledger-accounts';

/** El asiento propuesto incumple una regla de la partida doble. Nunca llega a la base de datos. */
export class LedgerValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Asiento contable no válido:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'LedgerValidationError';
    this.problems = problems;
  }
}

/** Suma del debe y del haber. Se acumula con `BigInt` para que ninguna suma desborde aunque haya muchos apuntes. */
export function sumByDirection(lines: readonly Pick<JournalLine, 'direction' | 'amountCents'>[]): Record<LedgerDirection, bigint> {
  return lines.reduce<Record<LedgerDirection, bigint>>(
    (totals, line) => {
      totals[line.direction] += BigInt(line.amountCents);
      return totals;
    },
    { DEBIT: 0n, CREDIT: 0n }
  );
}

/** Problemas de una clave de idempotencia (vacía, demasiado larga o con espacios en los extremos). */
export function idempotencyKeyProblems(idempotencyKey: string | undefined): string[] {
  const problems: string[] = [];
  const key = idempotencyKey?.trim() ?? '';
  if (key === '') problems.push('falta la clave de idempotencia');
  else if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) problems.push(`la clave de idempotencia supera ${MAX_IDEMPOTENCY_KEY_LENGTH} caracteres`);
  if (key !== idempotencyKey) problems.push('la clave de idempotencia no puede tener espacios al principio o al final');
  return problems;
}

/**
 * Comprueba un asiento antes de escribirlo (Regla 02 §3): al menos un apunte al debe y otro al haber, importes enteros
 * positivos, Σ DEBIT === Σ CREDIT, dimensiones obligatorias de cada cuenta y datos de cabecera. Lanza con todos los
 * problemas a la vez. La base de datos repite la comprobación del cuadre al confirmar (trigger diferido).
 */
export function validateJournal(input: PostJournalInput): void {
  const problems = idempotencyKeyProblems(input.idempotencyKey);
  if (!input.description?.trim()) problems.push('falta la descripción');
  if (input.kind === 'REVERSAL') problems.push('los contra-asientos se crean con reverseJournal(), no con postJournal()');

  if (input.lines.length < 2) problems.push('un asiento necesita al menos 2 apuntes');

  input.lines.forEach((line, index) => {
    const at = `apunte ${index + 1} (${line.account})`;
    if (!Number.isSafeInteger(line.amountCents) || line.amountCents <= 0) {
      problems.push(`${at}: el importe debe ser un entero de céntimos mayor que 0, recibido ${String(line.amountCents)}`);
    }
    const rule = ACCOUNT_RULES[line.account];
    if (!rule) {
      problems.push(`${at}: cuenta desconocida`);
      return;
    }
    for (const dimension of rule.requires) {
      const value = line[dimension];
      if (value === undefined || value === null || value === '') problems.push(`${at}: falta la dimensión obligatoria ${dimension}`);
    }
    // Un asiento pertenece a una sola entidad: ningún apunte puede llevar el dinero a otra.
    if (input.organizationId && line.organizationId && line.organizationId !== input.organizationId) {
      problems.push(`${at}: la entidad ${line.organizationId} no es la del asiento (${input.organizationId})`);
    }
  });

  // El cuadre solo se comprueba con importes válidos: con un importe roto ya hay un problema que corregir antes.
  const validAmounts = input.lines.every((line) => Number.isSafeInteger(line.amountCents) && line.amountCents > 0);
  const directions = new Set(input.lines.map((line) => line.direction));
  if (!directions.has('DEBIT') || !directions.has('CREDIT')) problems.push('un asiento necesita apuntes al debe y al haber');
  if (validAmounts) {
    const totals = sumByDirection(input.lines);
    if (totals.DEBIT !== totals.CREDIT) problems.push(`no cuadra: debe ${totals.DEBIT} ≠ haber ${totals.CREDIT}`);
  }

  if (problems.length > 0) throw new LedgerValidationError(problems);
}

/** Forma canónica de los apuntes para comparar dos asientos con independencia del orden. */
export function canonicalLines(lines: readonly JournalLine[]): string[] {
  return lines
    .map((line) =>
      [line.account, line.direction, line.amountCents, line.organizationId ?? '', line.initiativeId ?? '', line.userId ?? '', line.sponsorId ?? ''].join('|')
    )
    .sort();
}
