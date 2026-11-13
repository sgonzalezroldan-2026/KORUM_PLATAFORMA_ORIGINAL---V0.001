import type { Prisma } from '@/generated/prisma/client';
import type { KorumPrismaClient } from './prisma';

/**
 * Conexión que reciben los servicios: el cliente de KORUM (con su extensión de solo-alta) o una transacción abierta con
 * él. Se omiten los métodos que una transacción no tiene, así ambos encajan en el mismo tipo. Los servicios que escriben
 * varias filas usan `inTransaction` para que todo se aplique o nada, haya abierto o no quien llama una transacción.
 */
export type Db = Omit<KorumPrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends' | '$use' | '$metrics'>;

type RootDb = Db & {
  $transaction<R>(fn: (tx: Db) => Promise<R>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number }): Promise<R>;
};

/**
 * `true` si es el cliente raíz (puede abrir transacciones); `false` si ya estamos dentro de una.
 *
 * Con Prisma 7 el cliente que recibe una transacción interactiva **también tiene `$transaction`** (abriría una anidada, con punto de guardado), así que mirar solo eso
 * confundía una transacción con el cliente raíz: tras una violación de unicidad, `postJournal` creía poder consultar al ganador y lo hacía dentro de la transacción ya abortada
 * («transacción abortada», 25P02, `P2039`) en lugar de dejar pasar el `P2002` que documenta. Lo que solo tiene el cliente raíz es `$disconnect`.
 */
export function isRootDb(db: Db): db is RootDb {
  const client = db as Partial<RootDb> & { $disconnect?: unknown };
  return typeof client.$transaction === 'function' && typeof client.$disconnect === 'function';
}

/**
 * `true` solo si es el cliente de una transacción interactiva (tiene `$transaction` pero no `$disconnect`). Un objeto que no es un cliente de Prisma (un doble de prueba)
 * no cuenta como transacción.
 */
export function isTransactionDb(db: unknown): boolean {
  const client = db as { $transaction?: unknown; $disconnect?: unknown };
  return typeof client.$transaction === 'function' && typeof client.$disconnect !== 'function';
}

/** Ejecuta `fn` en una transacción: abre una nueva si hace falta o reutiliza la de quien llama. */
export async function inTransaction<R>(db: Db, fn: (tx: Db) => Promise<R>, options?: { maxWait?: number; timeout?: number }): Promise<R> {
  return isRootDb(db) ? db.$transaction(fn, options) : fn(db);
}

/**
 * Para operaciones que se ponen en cola tras un mismo bloqueo (una avalancha de compras, la numeración de facturas). Por defecto Prisma
 * abandona a los 2 s si no consigue conexión: en plena avalancha, una compra posible acabaría en error en lugar de esperar su turno.
 */
export const QUEUED_TRANSACTION = { maxWait: 20_000, timeout: 30_000 };

/** Violación de una restricción única (`P2002`), p. ej. dos webhooks simultáneos con la misma clave de idempotencia. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}
