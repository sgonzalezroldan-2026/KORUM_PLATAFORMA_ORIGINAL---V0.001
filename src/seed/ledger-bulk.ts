import type { PostJournalInput } from '@/core/finance/ledger-accounts';
import { assertSamePayload } from '@/core/finance/ledger.service';
import { validateJournal } from '@/core/finance/ledger-validation';
import type { KorumPrismaClient } from '@/lib/prisma';

/**
 * Carga masiva de asientos SOLO para semillas y migraciones de datos (no para operaciones normales, que usan `postJournal`).
 * Cada asiento se valida en memoria con `validateJournal` (cuadre, importes, claves) y se inserta con 2 sentencias por lote
 * en una transacción; los triggers de la base de datos vuelven a comprobar el cuadre, la inmutabilidad y la transacción al
 * confirmar. A diferencia de `postJournal`, NO consulta que cada iniciativa pertenezca a la entidad del asiento: las claves
 * foráneas solo garantizan que existan, y esa coherencia la comprueba `verifySeed` al terminar la semilla. Es idempotente por `idempotencyKey` (`ON CONFLICT DO NOTHING`): un asiento ya existente no se toca, pero se
 * comprueba que tiene el mismo contenido (si no, lanza `IdempotencyConflictError`).
 */

const BATCH_SIZE = 150;
const TRANSACTION_TIMEOUT_MS = 120_000;
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Cell = string | number | null;

/** Genera `($1,$2::tipo,…),($n,…)` y la lista plana de parámetros para un conjunto de filas. */
function valuesList(rows: Cell[][], casts: Array<string | null>): { sql: string; params: Cell[] } {
  const params: Cell[] = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((value, column) => {
      params.push(value);
      const cast = casts[column];
      return cast ? `$${params.length}::${cast}` : `$${params.length}`;
    });
    return `(${placeholders.join(',')})`;
  });
  return { sql: tuples.join(','), params };
}

export interface BulkResult {
  inserted: number;
  skipped: number;
}

export async function postJournalsBulk(db: KorumPrismaClient, schema: string, inputs: PostJournalInput[]): Promise<BulkResult> {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`Nombre de esquema no válido: ${schema}`);
  const quoted = `"${schema}"`;
  const keys = new Set<string>();
  for (const input of inputs) {
    validateJournal(input);
    if (keys.has(input.idempotencyKey)) throw new Error(`Clave de idempotencia repetida en la carga masiva: ${input.idempotencyKey}`);
    keys.add(input.idempotencyKey);
  }

  let inserted = 0;
  for (let offset = 0; offset < inputs.length; offset += BATCH_SIZE) {
    const batch = inputs.slice(offset, offset + BATCH_SIZE);
    inserted += await db.$transaction(
      async (tx) => {
        const headers = valuesList(
          batch.map((input) => [
            input.idempotencyKey,
            input.kind,
            input.organizationId ?? null,
            input.initiativeId ?? null,
            input.contributionId ?? null,
            input.walletTxId ?? null,
            input.payoutId ?? null,
            input.paycometReference ?? null,
            input.description.trim(),
            (input.occurredAt ?? new Date()).toISOString(),
            input.createdById ?? null
          ]),
          [null, `${quoted}."LedgerJournalKind"`, null, 'integer', 'integer', 'integer', 'integer', null, null, `timestamptz AT TIME ZONE 'UTC'`, null]
        );
        const created = await tx.$queryRawUnsafe<Array<{ id: number; idempotencyKey: string }>>(
          `INSERT INTO ${quoted}."LedgerJournal" ("idempotencyKey","kind","organizationId","initiativeId","contributionId","walletTxId","payoutId","paycometReference","description","occurredAt","createdById")
           VALUES ${headers.sql}
           ON CONFLICT ("idempotencyKey") DO NOTHING
           RETURNING "id","idempotencyKey"`,
          ...headers.params
        );
        const idByKey = new Map(created.map((row) => [row.idempotencyKey, row.id]));

        // Los asientos que ya existían deben ser exactamente la misma operación: una semilla vieja con otros importes
        // no puede darse por buena solo porque la clave coincida (mismo criterio que `postJournal`).
        const existingKeys = batch.filter((input) => !idByKey.has(input.idempotencyKey));
        if (existingKeys.length > 0) {
          const stored = await tx.ledgerJournal.findMany({ where: { idempotencyKey: { in: existingKeys.map((input) => input.idempotencyKey) } }, include: { entries: true } });
          const byKey = new Map(stored.map((journal) => [journal.idempotencyKey, journal]));
          for (const input of existingKeys) {
            const journal = byKey.get(input.idempotencyKey);
            if (!journal) throw new Error(`El asiento ${input.idempotencyKey} no se insertó ni existe: la carga masiva se detiene`);
            assertSamePayload(journal, input);
          }
        }
        if (created.length === 0) return 0;

        const lines: Cell[][] = [];
        for (const input of batch) {
          const journalId = idByKey.get(input.idempotencyKey);
          if (journalId === undefined) continue;
          for (const line of input.lines) {
            lines.push([journalId, line.account, line.direction, line.amountCents, line.organizationId ?? null, line.initiativeId ?? null, line.userId ?? null, line.sponsorId ?? null]);
          }
        }
        const entries = valuesList(lines, ['integer', `${quoted}."LedgerAccount"`, `${quoted}."LedgerDirection"`, 'integer', null, 'integer', null, 'integer']);
        await tx.$executeRawUnsafe(
          `INSERT INTO ${quoted}."EscrowLedgerEntry" ("journalId","account","direction","amountCents","organizationId","initiativeId","userId","sponsorId") VALUES ${entries.sql}`,
          ...entries.params
        );
        return created.length;
      },
      { timeout: TRANSACTION_TIMEOUT_MS }
    );
  }
  return { inserted, skipped: inputs.length - inserted };
}
