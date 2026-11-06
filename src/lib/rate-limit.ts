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
  return reserveUnits(db, key, rule, 1, now);
}

/**
 * Como `reserveAttempt`, pero un intento consume `units` del cupo (p. ej. las plazas que retiene una compra de entradas): se limita lo que se
 * bloquea, no solo cuántas veces se pide. Admitido solo si caben todas las unidades; si no, no consume nada.
 */
export async function reserveUnits(db: Db, key: string, rule: RateLimitRule, units: number, now: Date = new Date()): Promise<boolean> {
  if (!Number.isSafeInteger(units) || units < 1 || units > rule.limit) return false;
  const nowMs = BigInt(now.getTime());
  await db.rateLimit.createMany({ data: [{ id: key, key, count: 0, lastRequest: nowMs }], skipDuplicates: true });
  if (rule.windowMs !== null) {
    await db.rateLimit.updateMany({ where: { key, lastRequest: { lte: nowMs - BigInt(rule.windowMs) } }, data: { count: 0, lastRequest: nowMs } });
  }
  const { count } = await db.rateLimit.updateMany({ where: { key, count: { lte: rule.limit - units } }, data: { count: { increment: units }, lastRequest: nowMs } });
  return count === 1;
}

export async function releaseAttempt(db: Db, key: string): Promise<void> {
  await releaseUnits(db, key, 1);
}

/** Devuelve unidades consumidas por un intento que al final no hizo nada (sin restar por debajo de cero). */
export async function releaseUnits(db: Db, key: string, units: number): Promise<void> {
  const { count } = await db.rateLimit.updateMany({ where: { key, count: { gte: units } }, data: { count: { decrement: units } } });
  if (count === 0) await db.rateLimit.updateMany({ where: { key, count: { gt: 0 } }, data: { count: 0 } });
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

export interface PurgeRule {
  /** Prefijo de las claves de esta regla, p. ej. `gate-pin:ip:`. */
  prefix: string;
  /** La misma ventana con la que se reservan los intentos: pasada, el contador ya habría vuelto a cero. */
  windowMs: number;
}

/**
 * Borra los contadores con ventana que llevan más tiempo que ella sin actividad: su siguiente intento empezaría de cero igualmente, así que
 * borrarlos no cambia el comportamiento. Es necesario porque las claves por IP crecen con cada visitante nuevo. **Solo** toca las claves
 * de las reglas indicadas: los contadores sin ventana (`windowMs: null`, como `gate-pin:event:*`) no caducan solos y nunca se purgan aquí.
 * Devuelve cuántos borró, hasta `limit` por regla.
 */
export async function purgeStaleAttempts(db: Db, rules: readonly PurgeRule[], now: Date = new Date(), limit = 1000): Promise<number> {
  let purged = 0;
  for (const rule of rules) {
    const stale = await db.rateLimit.findMany({ where: { key: { startsWith: rule.prefix }, lastRequest: { lt: BigInt(now.getTime() - rule.windowMs) } }, take: limit, select: { key: true } });
    if (stale.length === 0) continue;
    const { count } = await db.rateLimit.deleteMany({ where: { key: { in: stale.map((row) => row.key) }, lastRequest: { lt: BigInt(now.getTime() - rule.windowMs) } } });
    purged += count;
  }
  return purged;
}
