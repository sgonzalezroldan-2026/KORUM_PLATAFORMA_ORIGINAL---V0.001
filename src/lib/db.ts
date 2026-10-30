import type { Prisma } from '@/generated/prisma/client';
import type { KorumPrismaClient } from './prisma';

/**
 * Conexión que reciben los servicios: el cliente de KORUM (con su extensión de solo-alta) o una transacción abierta con
 * él. Se omiten los métodos que una transacción no tiene, así ambos encajan en el mismo tipo. Los servicios que escriben
 * varias filas usan `inTransaction` para que todo se aplique o nada, haya abierto o no quien llama una transacción.
 */
export type Db = Omit<KorumPrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends' | '$use' | '$metrics'>;

type RootDb = Db & {
  $transaction<R>(fn: (tx: Db) => Promise<R>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number }): Promise<R>;
};

/** `true` si es el cliente raíz (puede abrir transacciones); `false` si ya estamos dentro de una. */
export function isRootDb(db: Db): db is RootDb {
  return typeof (db as Partial<RootDb>).$transaction === 'function';
}

/** Ejecuta `fn` en una transacción: abre una nueva si hace falta o reutiliza la de quien llama. */
export async function inTransaction<R>(db: Db, fn: (tx: Db) => Promise<R>): Promise<R> {
  return isRootDb(db) ? db.$transaction(fn) : fn(db);
}

/** Violación de una restricción única (`P2002`), p. ej. dos webhooks simultáneos con la misma clave de idempotencia. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}
