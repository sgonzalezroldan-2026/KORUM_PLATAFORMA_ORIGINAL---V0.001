import type { Prisma } from '@/generated/prisma/client';
import { isRootDb, isUniqueViolation, type Db } from '@/lib/db';
import type { JournalLine, PostJournalInput } from './ledger-accounts';
import { canonicalLines, idempotencyKeyProblems, LedgerValidationError, validateJournal } from './ledger-validation';

export {
  getAccountBalance,
  getBalancesByAccount,
  getRaisedFromLedger,
  getTrialBalance,
  type AccountBalance,
  type LedgerDimensions
} from './ledger-balances';

/**
 * Libro mayor de doble partida (Regla 02 §3, QA-C03).
 * - `postJournal`: alta de un asiento con sus apuntes, validado y con idempotencia por `idempotencyKey`.
 * - `reverseJournal`: corrección con un contra-asiento (los asientos no se editan, no se borran y no se amplían).
 * - Saldos: `ledger-balances.ts`, reexportados aquí.
 */

export type JournalWithEntries = Prisma.LedgerJournalGetPayload<{ include: { entries: true } }>;

export interface PostJournalResult {
  journal: JournalWithEntries;
  /** `false` si la clave ya existía y se devuelve el asiento original (operación repetida). */
  created: boolean;
}

/** La misma clave de idempotencia llega con un contenido distinto: es un error de programación, nunca se ignora. */
export class IdempotencyConflictError extends Error {
  constructor(idempotencyKey: string, detail: string) {
    super(`La clave de idempotencia «${idempotencyKey}» ya existe con otro contenido (${detail}).`);
    this.name = 'IdempotencyConflictError';
  }
}

export class JournalReversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalReversalError';
  }
}

const toLine = (entry: JournalWithEntries['entries'][number]): JournalLine => ({
  account: entry.account,
  direction: entry.direction,
  amountCents: entry.amountCents,
  organizationId: entry.organizationId,
  initiativeId: entry.initiativeId,
  userId: entry.userId,
  sponsorId: entry.sponsorId
});

function findByKey(db: Db, idempotencyKey: string) {
  return db.ledgerJournal.findUnique({ where: { idempotencyKey }, include: { entries: true } });
}

/** Reintentos para ver el asiento ganador de una carrera por la misma clave. */
const WINNER_LOOKUP_ATTEMPTS = 6;

/**
 * Busca el asiento que ganó una carrera por la misma clave. En PostgreSQL el perdedor espera a que el ganador confirme, así
 * que suele bastar una lectura; los reintentos breves cubren servidores que reparten las conexiones de otra forma (p. ej. la
 * base local de desarrollo basada en PGlite) sin esperar nunca más de medio segundo en total.
 */
async function waitForWinner(db: Db, idempotencyKey: string): Promise<JournalWithEntries | null> {
  for (let attempt = 1; attempt <= WINNER_LOOKUP_ATTEMPTS; attempt += 1) {
    const winner = await findByKey(db, idempotencyKey);
    if (winner) return winner;
    await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
  }
  return null;
}

/**
 * Comprueba que el asiento guardado con esa clave es exactamente la misma operación que se intenta registrar. También lo usa
 * la carga masiva (`src/seed/ledger-bulk.ts`) para los asientos que ya existían.
 */
export function assertSamePayload(existing: JournalWithEntries, input: PostJournalInput): JournalWithEntries {
  const differences: string[] = [];
  if (existing.kind !== input.kind) differences.push(`tipo ${existing.kind} ≠ ${input.kind}`);
  const header: Array<[string, unknown, unknown]> = [
    ['entidad', existing.organizationId, input.organizationId],
    ['iniciativa', existing.initiativeId, input.initiativeId],
    ['aportación', existing.contributionId, input.contributionId],
    ['movimiento de Mi Hucha', existing.walletTxId, input.walletTxId],
    ['liquidación', existing.payoutId, input.payoutId],
    ['referencia de Paycomet', existing.paycometReference, input.paycometReference]
  ];
  for (const [label, stored, incoming] of header) {
    if ((stored ?? null) !== (incoming ?? null)) differences.push(`${label} distinta`);
  }
  const stored = canonicalLines(existing.entries.map(toLine));
  const incoming = canonicalLines(input.lines);
  if (stored.length !== incoming.length || stored.some((line, index) => line !== incoming[index])) differences.push('apuntes distintos');
  if (differences.length > 0) throw new IdempotencyConflictError(input.idempotencyKey, differences.join(', '));
  return existing;
}

/**
 * Las iniciativas citadas existen y pertenecen a la entidad indicada (en la cabecera o en el apunte). Evita huchas
 * «fantasma» o dinero de una entidad apuntado en la iniciativa de otra. Las claves foráneas cubren el resto de dimensiones.
 */
async function assertInitiativesBelongToOrganization(db: Db, input: PostJournalInput): Promise<void> {
  const expected = new Map<number, Set<string>>();
  const note = (initiativeId: number | null | undefined, organizationId: string | null | undefined) => {
    if (initiativeId === null || initiativeId === undefined) return;
    const owners = expected.get(initiativeId) ?? new Set<string>();
    const owner = organizationId ?? input.organizationId;
    if (owner) owners.add(owner);
    expected.set(initiativeId, owners);
  };
  note(input.initiativeId, input.organizationId);
  input.lines.forEach((line) => note(line.initiativeId, line.organizationId));
  if (expected.size === 0) return;

  const found = await db.initiative.findMany({ where: { id: { in: [...expected.keys()] } }, select: { id: true, organizationId: true } });
  const ownerOf = new Map(found.map((initiative) => [initiative.id, initiative.organizationId]));
  const problems: string[] = [];
  for (const [initiativeId, owners] of expected) {
    const actual = ownerOf.get(initiativeId);
    if (actual === undefined) problems.push(`no existe la iniciativa ${initiativeId}`);
    else for (const owner of owners) if (owner !== actual) problems.push(`la iniciativa ${initiativeId} es de la entidad ${actual}, no de ${owner}`);
  }
  if (problems.length > 0) throw new LedgerValidationError(problems);
}

function entryData(line: JournalLine): Prisma.EscrowLedgerEntryUncheckedCreateWithoutJournalInput {
  return {
    account: line.account,
    direction: line.direction,
    amountCents: line.amountCents,
    organizationId: line.organizationId ?? null,
    initiativeId: line.initiativeId ?? null,
    userId: line.userId ?? null,
    sponsorId: line.sponsorId ?? null
  };
}

/**
 * Registra un asiento con todos sus apuntes en una sola escritura atómica. Repetir la misma `idempotencyKey` con la misma
 * operación devuelve el asiento existente (`created: false`); con otra operación lanza `IdempotencyConflictError`.
 *
 * Concurrencia: con el cliente raíz, si otro proceso gana la carrera por la clave, se devuelve el asiento ganador. Dentro
 * de una transacción ajena, la violación de unicidad aborta esa transacción: quien la abrió debe reintentar (al reintentar
 * encontrará el asiento y no hará nada). Es el comportamiento que necesitan los webhooks.
 */
export async function postJournal(db: Db, input: PostJournalInput): Promise<PostJournalResult> {
  validateJournal(input);

  const existing = await findByKey(db, input.idempotencyKey);
  if (existing) return { journal: assertSamePayload(existing, input), created: false };

  await assertInitiativesBelongToOrganization(db, input);

  try {
    const journal = await db.ledgerJournal.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        description: input.description.trim(),
        organizationId: input.organizationId ?? null,
        initiativeId: input.initiativeId ?? null,
        contributionId: input.contributionId ?? null,
        walletTxId: input.walletTxId ?? null,
        payoutId: input.payoutId ?? null,
        paycometReference: input.paycometReference ?? null,
        occurredAt: input.occurredAt ?? new Date(),
        createdById: input.createdById ?? null,
        entries: { create: input.lines.map(entryData) }
      },
      include: { entries: true }
    });
    return { journal, created: true };
  } catch (error) {
    if (isUniqueViolation(error) && isRootDb(db)) {
      const winner = await waitForWinner(db, input.idempotencyKey);
      if (winner) return { journal: assertSamePayload(winner, input), created: false };
    }
    throw error;
  }
}

export interface ReverseJournalInput {
  journalId: number;
  idempotencyKey: string;
  description: string;
  createdById?: string | null;
  occurredAt?: Date;
}

/** Devuelve el contra-asiento ya existente con esa clave si anula ese mismo asiento; si la clave se usó para otra cosa, falla. */
function asExistingReversal(existing: JournalWithEntries, input: ReverseJournalInput): PostJournalResult {
  if (existing.kind === 'REVERSAL' && existing.reversesJournalId === input.journalId) return { journal: existing, created: false };
  throw new IdempotencyConflictError(input.idempotencyKey, 'no es el contra-asiento de ese asiento');
}

/**
 * Anula un asiento con su contra-asiento: mismos apuntes con el debe y el haber intercambiados, `kind = REVERSAL` y
 * `reversesJournalId` apuntando al original. Un asiento solo se puede anular una vez (también lo impide la base de datos)
 * y un contra-asiento no se anula: si hace falta, se registra el asiento correcto de nuevo. Idempotente por la clave y
 * seguro ante anulaciones simultáneas (con el cliente raíz devuelve el ganador o `JournalReversalError`).
 */
export async function reverseJournal(db: Db, input: ReverseJournalInput): Promise<PostJournalResult> {
  const problems = idempotencyKeyProblems(input.idempotencyKey);
  if (!input.description?.trim()) problems.push('falta la descripción del contra-asiento');
  if (problems.length > 0) throw new LedgerValidationError(problems);

  const existing = await findByKey(db, input.idempotencyKey);
  if (existing) return asExistingReversal(existing, input);

  const original = await db.ledgerJournal.findUnique({
    where: { id: input.journalId },
    include: { entries: true, reversedBy: { include: { entries: true } } }
  });
  if (!original) throw new JournalReversalError(`No existe el asiento ${input.journalId}.`);
  if (original.kind === 'REVERSAL') throw new JournalReversalError(`El asiento ${original.id} ya es un contra-asiento y no se anula.`);
  if (original.reversedBy) {
    // Otra llamada con la misma clave ganó justo entre las dos lecturas: es la misma operación.
    if (original.reversedBy.idempotencyKey === input.idempotencyKey) return { journal: original.reversedBy, created: false };
    throw new JournalReversalError(`El asiento ${original.id} ya fue anulado por el asiento ${original.reversedBy.id}.`);
  }

  try {
    const journal = await db.ledgerJournal.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        kind: 'REVERSAL',
        description: input.description.trim(),
        organizationId: original.organizationId,
        initiativeId: original.initiativeId,
        contributionId: original.contributionId,
        walletTxId: original.walletTxId,
        payoutId: original.payoutId,
        paycometReference: original.paycometReference,
        occurredAt: input.occurredAt ?? new Date(),
        createdById: input.createdById ?? null,
        reversesJournalId: original.id,
        entries: {
          create: original.entries.map((entry) => entryData({ ...toLine(entry), direction: entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT' }))
        }
      },
      include: { entries: true }
    });
    return { journal, created: true };
  } catch (error) {
    if (!isUniqueViolation(error) || !isRootDb(db)) throw error;
    // Carrera: el ganador, tenga o no nuestra clave, es el único contra-asiento que apunta al original.
    for (let attempt = 1; attempt <= WINNER_LOOKUP_ATTEMPTS; attempt += 1) {
      const winner = await db.ledgerJournal.findUnique({ where: { reversesJournalId: original.id }, include: { entries: true } });
      if (winner) {
        if (winner.idempotencyKey === input.idempotencyKey) return { journal: winner, created: false };
        throw new JournalReversalError(`El asiento ${original.id} ya fue anulado por el asiento ${winner.id}.`);
      }
      const sameKey = await findByKey(db, input.idempotencyKey);
      if (sameKey) return asExistingReversal(sameKey, input);
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
    throw error;
  }
}
