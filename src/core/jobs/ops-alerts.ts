import type { Prisma } from '@/generated/prisma/client';
import type { OpsAlertSeverity, OpsAlertType } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';

/**
 * Alertas de operación para la consola del Super-Admin (QA-OPS01, QA-OPS02). Una misma `dedupeKey` es un mismo problema: la
 * primera vez abre la alerta y las siguientes solo cuentan la repetición y actualizan el detalle, así que una tarea que falla cada
 * diez minutos no llena la bandeja. Si el problema reaparece después de resuelto, se reabre.
 *
 * El detalle nunca lleva datos personales (ni emails, ni NIF, ni nombres): solo identificadores internos e importes.
 */

export interface OpsAlertInput {
  type: OpsAlertType;
  severity: OpsAlertSeverity;
  dedupeKey: string;
  organizationId?: string | null;
  targetType?: string;
  targetId?: string;
  detail: Prisma.InputJsonObject;
}

export async function raiseAlert(db: Db, input: OpsAlertInput, now: Date = new Date()): Promise<void> {
  const { type, severity, dedupeKey, detail } = input;
  await db.opsAlert.upsert({
    where: { dedupeKey },
    create: { type, severity, dedupeKey, organizationId: input.organizationId ?? null, targetType: input.targetType ?? null, targetId: input.targetId ?? null, detailJson: detail, firstSeenAt: now, lastSeenAt: now },
    update: { severity, detailJson: detail, lastSeenAt: now, occurrences: { increment: 1 }, status: 'OPEN', resolvedAt: null }
  });
}

/**
 * Para alertas que describen un estado (facturas atascadas, ventanas por vencer): cierra las abiertas de ese tipo que ya no están entre
 * las claves activas. `activeKeys` debe ser la lista **completa** de lo que sigue mal; una lista recortada cerraría alertas vigentes.
 */
export async function resolveAlertsNotIn(db: Db, type: OpsAlertType, activeKeys: readonly string[], now: Date = new Date()): Promise<number> {
  const { count } = await db.opsAlert.updateMany({ where: { type, status: 'OPEN', dedupeKey: { notIn: [...activeKeys] } }, data: { status: 'RESOLVED', resolvedAt: now } });
  return count;
}

/** Cierra la alerta cuando el problema ya no existe (p. ej. la conciliación vuelve a cuadrar). No hace nada si no estaba abierta. */
export async function resolveAlert(db: Db, dedupeKey: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await db.opsAlert.updateMany({ where: { dedupeKey, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: now } });
  return count === 1;
}
