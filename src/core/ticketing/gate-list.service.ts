import { createHash } from 'node:crypto';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, type SessionActor } from '@/repositories/tenant-guard';
import { assertGateSessionLive, GATE_ROLES, type EventRef } from './check-in.service';
import type { GateList, GateListPass } from './gate-offline';

/**
 * Lista de pases para validar sin cobertura (QA-S04). Solo lo imprescindible: identificador, plazas, usadas y la huella de la firma; ni emails, ni
 * importes, ni la firma entera. Solo pases de entrada (`EVENT`) pagados y no anulados. No va firmada: el móvil no podría comprobarla y el servidor
 * vuelve a validar cada lectura al sincronizar, así que una lista manipulada solo engaña al propio móvil que la manipula.
 */

/** Más pases de los que caben en un evento escolar; el tope evita que una lista descomunal bloquee el móvil. */
export const GATE_LIST_MAX_PASSES = 5_000;

/** Los 22 primeros caracteres del SHA-256 de la firma (la misma cuenta que `digestSignature` del móvil). */
export const signatureDigest = (signature: string): string => createHash('sha256').update(signature, 'utf8').digest('base64url').slice(0, 22);

export async function buildGateList(db: KorumPrismaClient, actor: SessionActor, event: EventRef, now: Date = new Date()): Promise<GateList> {
  await authorizeTenant(db, actor, event.organizationId, { roles: GATE_ROLES, action: 'gate.list', targetType: 'Initiative', targetId: event.initiativeId });
  await assertGateSessionLive(db, actor, now);
  const owner = await db.initiative.findUnique({ where: { id: event.initiativeId }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId: event.organizationId, resourceType: 'Initiative', resourceId: event.initiativeId, resourceLabel: 'Initiative', ownerOrganizationId: owner?.organizationId ?? null });
  const rows = await db.ticketPass.findMany({
    where: { initiativeId: event.initiativeId, subtype: 'EVENT', revokedAt: null, contribution: { status: 'COMPLETED' } },
    select: { uuid: true, quantity: true, checkedInCount: true, qrHmacSignature: true },
    orderBy: { id: 'asc' },
    take: GATE_LIST_MAX_PASSES
  });
  const passes: GateListPass[] = rows.map((row) => ({ u: row.uuid, q: row.quantity, c: row.checkedInCount, h: signatureDigest(row.qrHmacSignature) }));
  return { eventId: event.initiativeId, generatedAt: now.getTime(), passes };
}
