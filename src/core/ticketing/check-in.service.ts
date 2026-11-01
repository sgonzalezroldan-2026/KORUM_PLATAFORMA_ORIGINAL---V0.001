import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { parsePassQrPayload, verifyPassSignature } from './qr-signature';

/**
 * Lectura de un QR en la puerta (QA-REG01). La firma demuestra que el pase lo emitió KORUM; si ya se ha usado lo dice el servidor. Un rechazo
 * es un resultado normal, no un error: se devuelve para que quede guardado y la portería lo muestre (la alerta roja la pinta el Sprint 4.5).
 */

const GATE_ROLES: readonly MemberRole[] = ['GATEKEEPER', 'DIRECTOR', 'COSIGNER'];
const CLOSED_EVENT_STATUSES = new Set(['REFUNDING', 'REFUNDED', 'CANCELLED']);

export type CheckInResult =
  | { status: 'ACCEPTED'; entered: number; remaining: number; quantity: number; serialCode: string }
  | { status: 'INSUFFICIENT'; remaining: number; quantity: number; firstAccessAt: Date | null }
  | { status: 'EXHAUSTED'; quantity: number; firstAccessAt: Date | null }
  | { status: 'INVALID_SIGNATURE' | 'OTHER_EVENT' | 'REVOKED' | 'NOT_PAID' | 'NOT_APPLICABLE' | 'EVENT_CLOSED' };

export interface EventRef {
  organizationId: string;
  initiativeId: number;
}

/** Una sesión de portería cerrada desde el panel deja de valer al instante, aunque el token se comprobara hace un momento. */
export async function assertGateSessionLive(db: KorumPrismaClient, actor: SessionActor, now: Date): Promise<void> {
  if (actor.kind !== 'gate') return;
  const session = await db.gateSession.findUnique({ where: { id: actor.gateSessionId }, select: { revokedAt: true, expiresAt: true } });
  if (session && !session.revokedAt && session.expiresAt > now) return;
  await recordAudit(db, actor, { action: 'gate.session_rejected', organizationId: actor.organizationId, targetType: 'GateSession', targetId: actor.gateSessionId, metadata: { initiativeId: actor.initiativeId } });
  throw new TenantAccessError('GATE_SESSION_OTHER_EVENT');
}

/** Valida un QR y deja entrar `quantity` personas. Dos lecturas simultáneas del mismo pase van una detrás de otra. */
export async function checkInPass(db: KorumPrismaClient, secret: string, actor: SessionActor, event: EventRef, payload: string, quantity: number, now: Date = new Date()): Promise<CheckInResult> {
  await authorizeTenant(db, actor, event.organizationId, { roles: GATE_ROLES, action: 'gate.check_in', targetType: 'Initiative', targetId: event.initiativeId });
  await assertGateSessionLive(db, actor, now);
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError('El número de personas que entran debe ser un entero positivo.');
  const gateSessionId = actor.kind === 'gate' ? actor.gateSessionId : null;

  const parsed = parsePassQrPayload(payload);
  if (!parsed || !verifyPassSignature(secret, parsed.passUuid, parsed.signature)) {
    await recordAudit(db, actor, { action: 'gate.qr_invalid', organizationId: event.organizationId, targetType: 'Initiative', targetId: String(event.initiativeId), metadata: {} });
    return { status: 'INVALID_SIGNATURE' };
  }
  const reference = await db.ticketPass.findUnique({ where: { uuid: parsed.passUuid }, select: { id: true, initiativeId: true, initiative: { select: { organizationId: true } } } });
  // También la entidad: quien tiene cargo en la suya no puede pasar el identificador de un evento ajeno.
  if (!reference || reference.initiativeId !== event.initiativeId || reference.initiative.organizationId !== event.organizationId) {
    // Sin revelar de qué evento o entidad es; el identificador solo queda en la auditoría.
    await recordAudit(db, actor, { action: 'gate.qr_other_event', organizationId: event.organizationId, targetType: 'Initiative', targetId: String(event.initiativeId), metadata: { passUuid: parsed.passUuid } });
    return { status: 'OTHER_EVENT' };
  }

  return db.$transaction(async (tx): Promise<CheckInResult> => {
    const pass = await tx.ticketPass.update({
      where: { id: reference.id },
      data: { checkedInCount: { increment: 0 } },
      include: { contribution: { select: { status: true } }, initiative: { select: { status: true } } }
    });
    const reject = async (reason: string) => tx.ticketCheckIn.create({ data: { ticketPassId: pass.id, gateSessionId, quantity, accepted: false, reason, createdAt: now } });
    const firstAccess = async () => (await tx.ticketCheckIn.findFirst({ where: { ticketPassId: pass.id, accepted: true }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }))?.createdAt ?? null;

    if (pass.subtype === 'RAFFLE') return (await reject('NOT_APPLICABLE'), { status: 'NOT_APPLICABLE' });
    if (pass.revokedAt) return (await reject('REVOKED'), { status: 'REVOKED' });
    if (CLOSED_EVENT_STATUSES.has(pass.initiative.status)) return (await reject('EVENT_CLOSED'), { status: 'EVENT_CLOSED' });
    if (pass.contribution.status !== 'COMPLETED') return (await reject('NOT_PAID'), { status: 'NOT_PAID' });

    const remaining = pass.quantity - pass.checkedInCount;
    if (remaining === 0) {
      await reject('PASE_AGOTADO');
      return { status: 'EXHAUSTED', quantity: pass.quantity, firstAccessAt: await firstAccess() };
    }
    if (quantity > remaining) {
      await reject('CANTIDAD_SUPERIOR');
      return { status: 'INSUFFICIENT', remaining, quantity: pass.quantity, firstAccessAt: await firstAccess() };
    }
    await tx.ticketPass.update({ where: { id: pass.id }, data: { checkedInCount: { increment: quantity }, lastCheckedInAt: now } });
    await tx.ticketCheckIn.create({ data: { ticketPassId: pass.id, gateSessionId, quantity, accepted: true, createdAt: now } });
    return { status: 'ACCEPTED', entered: quantity, remaining: remaining - quantity, quantity: pass.quantity, serialCode: pass.serialCode };
  });
}

/** `🟢 X / Y asistentes dentro del recinto`: solo cifras, sin datos de nadie. */
export async function getGateSummary(db: KorumPrismaClient, actor: SessionActor, event: EventRef, now: Date = new Date()): Promise<{ checkedIn: number; capacity: number }> {
  await authorizeTenant(db, actor, event.organizationId, { roles: GATE_ROLES, action: 'gate.summary', targetType: 'Initiative', targetId: event.initiativeId });
  await assertGateSessionLive(db, actor, now);
  const owner = await db.initiative.findUnique({ where: { id: event.initiativeId }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId: event.organizationId, resourceType: 'Initiative', resourceId: event.initiativeId, resourceLabel: 'Initiative', ownerOrganizationId: owner?.organizationId ?? null });
  const totals = await db.ticketPass.aggregate({ where: { initiativeId: event.initiativeId, revokedAt: null }, _sum: { checkedInCount: true, quantity: true } });
  return { checkedIn: totals._sum.checkedInCount ?? 0, capacity: totals._sum.quantity ?? 0 };
}
