import type { Db } from './db';

/**
 * Limitador de intentos sobre la tabla `RateLimit`: el contador vuelve a cero tras `windowMs` sin intentos admitidos, medidos desde el último
 * (`lastRequest`), así que nunca caben más de `limit` en una ventana cualquiera. Los intentos ya bloqueados no alargan el bloqueo. Se
 * reserva **antes** de hacer el trabajo, con una actualización condicional: varios intentos a la vez no pueden colarse por encima del
 * límite. Quien acaba bien y no debe contar lo devuelve con `releaseAttempt`.
 */

export interface RateLimitRule {
  limit: number;
  /** `null`: el contador no caduca solo; se borra con `clearAttempts`. */
  windowMs: number | null;
}

export async function reserveAttempt(db: Db, key: string, rule: RateLimitRule, now: Date = new Date()): Promise<boolean> {
  const nowMs = BigInt(now.getTime());
  await db.rateLimit.createMany({ data: [{ id: key, key, count: 0, lastRequest: nowMs }], skipDuplicates: true });
  if (rule.windowMs !== null) {
    await db.rateLimit.updateMany({ where: { key, lastRequest: { lte: nowMs - BigInt(rule.windowMs) } }, data: { count: 0, lastRequest: nowMs } });
  }
  const { count } = await db.rateLimit.updateMany({ where: { key, count: { lt: rule.limit } }, data: { count: { increment: 1 }, lastRequest: nowMs } });
  return count === 1;
}

export async function releaseAttempt(db: Db, key: string): Promise<void> {
  await db.rateLimit.updateMany({ where: { key, count: { gt: 0 } }, data: { count: { decrement: 1 } } });
}

export async function countAttempts(db: Db, key: string): Promise<number> {
  const row = await db.rateLimit.findUnique({ where: { key }, select: { count: true } });
  return row?.count ?? 0;
}

export async function lastAttemptAt(db: Db, key: string): Promise<number | null> {
  const row = await db.rateLimit.findUnique({ where: { key }, select: { lastRequest: true } });
  return row ? Number(row.lastRequest) : null;
}

export async function clearAttempts(db: Db, key: string): Promise<void> {
  await db.rateLimit.deleteMany({ where: { key } });
}
