import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { getEnv } from '@/config/env';

/**
 * Cliente de base de datos de KORUM (Prisma ORM 7 + adaptador `pg`).
 * La extensión `append-only` impide editar o borrar asientos, apuntes y auditoría desde la aplicación; la base de datos lo
 * impide además con triggers (migración `*_ledger_immutability`), así que ni un SQL escrito a mano puede saltárselo.
 */

const APPEND_ONLY_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);

/**
 * Los asientos solo se crean de uno en uno con sus apuntes anidados (`ledgerJournal.create`, que usa `postJournal`).
 * Crear apuntes sueltos o asientos en bloque saltaría la validación del servicio.
 */
const LEDGER_BULK_OR_LOOSE_CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);

export class ImmutableRecordError extends Error {
  constructor(model: string, operation: string) {
    super(`KORUM_IMMUTABLE: ${operation} no está permitido en ${model}; la contabilidad y la auditoría solo admiten altas (corrige con un contra-asiento).`);
    this.name = 'ImmutableRecordError';
  }
}

interface AppendOnlyArgs {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

function appendOnly({ model, operation, args, query }: AppendOnlyArgs) {
  if (APPEND_ONLY_OPERATIONS.has(operation)) throw new ImmutableRecordError(model ?? 'modelo', operation);
  return query(args);
}

/** Asientos: además de solo-alta, nada de altas en bloque (cada asiento se valida con sus apuntes). */
function journalGuard(params: AppendOnlyArgs) {
  if (params.operation === 'createMany' || params.operation === 'createManyAndReturn') {
    throw new ImmutableRecordError(params.model ?? 'LedgerJournal', `${params.operation} (usa postJournal)`);
  }
  return appendOnly(params);
}

/** Apuntes: solo nacen anidados dentro de su asiento; nunca sueltos ni en bloque. */
function entryGuard(params: AppendOnlyArgs) {
  if (LEDGER_BULK_OR_LOOSE_CREATES.has(params.operation)) {
    throw new ImmutableRecordError(params.model ?? 'EscrowLedgerEntry', `${params.operation} (los apuntes se crean con postJournal)`);
  }
  return appendOnly(params);
}

export interface CreatePrismaClientOptions {
  connectionString: string;
  /** Esquema de PostgreSQL. Por defecto `public`; las pruebas de integración usan uno propio (`korum_test`). */
  schema?: string;
  /** Tamaño máximo del pool de conexiones (por defecto, el de `pg`: 10). */
  maxConnections?: number;
}

export function createPrismaClient({ connectionString, schema, maxConnections }: CreatePrismaClientOptions) {
  const adapter = new PrismaPg({ connectionString, max: maxConnections }, schema ? { schema } : undefined);
  return new PrismaClient({ adapter }).$extends({
    name: 'korum-append-only',
    query: {
      ledgerJournal: { $allOperations: journalGuard },
      escrowLedgerEntry: { $allOperations: entryGuard },
      auditLog: { $allOperations: appendOnly },
      raffleDraw: { $allOperations: appendOnly }
    }
  });
}

export type KorumPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as { korumPrisma?: KorumPrismaClient };

/**
 * Cliente compartido de la aplicación. Se crea al primer uso (no al importar) para que `next build` no necesite la base de
 * datos, y se reutiliza entre recargas en desarrollo para no agotar conexiones.
 */
export function getPrisma(): KorumPrismaClient {
  globalForPrisma.korumPrisma ??= createPrismaClient({ connectionString: getEnv().DATABASE_URL });
  return globalForPrisma.korumPrisma;
}
