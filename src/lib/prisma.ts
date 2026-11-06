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

/**
 * Auditoría: solo-alta, con la única excepción que también admite su trigger: vaciar a la vez la IP (HMAC) y el navegador cuando vence su
 * plazo de conservación (`DATA_RETENTION_PURGE`, 12 meses). Cualquier otro campo en `data` se rechaza.
 */
function auditGuard(params: AppendOnlyArgs) {
  const data = (params.args as { data?: Record<string, unknown> } | undefined)?.data;
  const onlyAnonymizes = params.operation === 'updateMany' && data !== undefined && Object.keys(data).sort().join(',') === 'ipHash,userAgent' && data.ipHash === null && data.userAgent === null;
  return onlyAnonymizes ? params.query(params.args) : appendOnly(params);
}

export interface CreatePrismaClientOptions {
  connectionString: string;
  /** Esquema de PostgreSQL. Por defecto `public`; las pruebas de integración usan uno propio (`korum_test`). */
  schema?: string;
  /** Tamaño máximo del pool de conexiones (por defecto, el de `pg`: 10). */
  maxConnections?: number;
  /** Esperas por defecto de las transacciones interactivas (Prisma: 2 s para conseguir conexión, 5 s de duración). */
  transactionOptions?: { maxWait?: number; timeout?: number };
}

export function createPrismaClient({ connectionString, schema, maxConnections, transactionOptions }: CreatePrismaClientOptions) {
  const adapter = new PrismaPg({ connectionString, max: maxConnections }, schema ? { schema } : undefined);
  return new PrismaClient({ adapter, ...(transactionOptions ? { transactionOptions } : {}) }).$extends({
    name: 'korum-append-only',
    query: {
      ledgerJournal: { $allOperations: journalGuard },
      escrowLedgerEntry: { $allOperations: entryGuard },
      auditLog: { $allOperations: auditGuard },
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
  globalForPrisma.korumPrisma ??= createPrismaClient(connectionFromUrl(getEnv().DATABASE_URL));
  return globalForPrisma.korumPrisma;
}

/**
 * `?schema=` en `DATABASE_URL` (como lo entiende `prisma migrate`) elige el esquema de PostgreSQL: lo usan las pruebas de navegador, que
 * trabajan en un esquema propio (`korum_e2e`). `pg` no conoce ese parámetro ni `connection_limit`, así que se quitan de la cadena y se pasan
 * al adaptador.
 */
export function connectionFromUrl(databaseUrl: string): CreatePrismaClientOptions {
  const parsed = new URL(databaseUrl);
  const schema = parsed.searchParams.get('schema') ?? undefined;
  // `connection_limit` (también de Prisma): la base local sin Docker (PGlite) solo admite una conexión a la vez.
  const limit = Number(parsed.searchParams.get('connection_limit') ?? '') || undefined;
  parsed.searchParams.delete('schema');
  parsed.searchParams.delete('connection_limit');
  // Con una sola conexión las transacciones se ponen en cola: los 2 s que Prisma da para conseguir conexión son de un servidor con pool.
  const queued = limit === 1 ? { transactionOptions: { maxWait: 60_000, timeout: 120_000 } } : {};
  return { connectionString: schema || limit ? parsed.toString() : databaseUrl, schema, maxConnections: limit, ...queued };
}
