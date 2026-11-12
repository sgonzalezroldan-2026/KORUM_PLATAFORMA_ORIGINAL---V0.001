import type { Db } from '@/lib/db';

/**
 * Bloquea las iniciativas con PIN de portería **antes** de bloquear la entidad, que es el orden del resto del código (iniciativa y luego entidad: Auto-Impulso,
 * reembolso masivo, cupos). Quien va a llamar a `revokeGateAccess` tras bloquear la entidad lo llama primero, y así dos operaciones cruzadas se ordenan en lugar
 * de bloquearse entre sí (auditoría de seguridad del 5.2, N2).
 */
export async function lockGatePinInitiatives(tx: Db, organizationId: string, now: Date): Promise<void> {
  await tx.initiative.updateMany({ where: { organizationId, gatePinHash: { not: null } }, data: { updatedAt: now } });
}

/**
 * Cierra el acceso de portería de una entidad cuando cambia quién firma por ella (baja de un puesto o relevo completado, Sprint 5.2, auditoría de seguridad M9).
 * El PIN de un evento lo configura una persona de la entidad: quien sale no debe seguir entrando al listado ni al control de entrada con el que ya tenía. Se
 * revocan las sesiones de portería abiertas y se borra el PIN de los eventos que lo tengan; quien dirige ahora genera uno nuevo desde el panel
 * (`/panel/[orgSlug]/porteria`). No toca las entradas ya leídas ni los pases. Devuelve cuántas sesiones se cerraron y cuántos PIN se borraron.
 */
export async function revokeGateAccess(tx: Db, organizationId: string, now: Date): Promise<{ sessions: number; pins: number }> {
  const sessions = await tx.gateSession.updateMany({ where: { initiative: { organizationId }, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } });
  const pins = await tx.initiative.updateMany({ where: { organizationId, gatePinHash: { not: null } }, data: { gatePinHash: null, gatePinExpiresAt: null } });
  return { sessions: sessions.count, pins: pins.count };
}
