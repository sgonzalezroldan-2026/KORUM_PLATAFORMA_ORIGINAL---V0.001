import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { firstNotice, firstRejectedNotice } from './gate-limits';
import { clampScanTime, MAX_PEOPLE_PER_SCAN } from './gate-rules';
import { parsePassQrPayload, verifyPassSignature } from './qr-signature';

/**
 * Lectura de un QR en la puerta (QA-REG01). La firma demuestra que el pase lo emitió KORUM; si ya se ha usado lo dice el servidor. Un rechazo
 * es un resultado normal, no un error: se devuelve para que quede guardado y la portería lo muestre (alerta roja, sonido y vibración). Un pase de varias
 * plazas pregunta cuántas personas entran (`quantity: 'ASK'`) y un móvil sin red envía sus lecturas al volver con un `clientScanId`: reenviarlas no deja entrar dos veces.
 */

export const GATE_ROLES: readonly MemberRole[] = ['GATEKEEPER', 'DIRECTOR', 'COSIGNER'];
const CLOSED_EVENT_STATUSES = new Set(['REFUNDING', 'REFUNDED', 'CANCELLED']);

export type CheckInResult =
  | { status: 'ACCEPTED'; entered: number; remaining: number; quantity: number; serialCode: string }
  /** Quedan varias plazas: no se ha dejado entrar a nadie hasta saber cuántas personas entran ahora (`Entran 2 de 4`). */
  | { status: 'CHOOSE'; remaining: number; quantity: number; serialCode: string }
  /** Esta lectura sin red ya se había recibido antes (reenvío de la cola): no se repite nada. */
  | { status: 'DUPLICATE_SCAN'; accepted: boolean }
  | { status: 'INSUFFICIENT'; remaining: number; quantity: number; firstAccessAt: Date | null }
  | { status: 'EXHAUSTED'; quantity: number; firstAccessAt: Date | null }
  | { status: 'INVALID_SIGNATURE' | 'OTHER_EVENT' | 'REVOKED' | 'NOT_PAID' | 'NOT_APPLICABLE' | 'EVENT_CLOSED' };

export interface CheckInOptions {
  /** Lo genera el móvil por lectura; con él, repetir la petición es inofensivo. */
  clientScanId?: string;
  /** La lectura se hizo sin red: `scannedAt` es la hora de entonces (se acota). */
  offline?: boolean;
  scannedAt?: Date;
}

export interface EventRef {
  organizationId: string;
  initiativeId: number;
}

/** Una sesión de portería cerrada desde el panel deja de valer al instante, aunque el token se comprobara hace un momento. */
export async function assertGateSessionLive(db: KorumPrismaClient, actor: SessionActor, now: Date): Promise<void> {
  if (actor.kind !== 'gate') return;
  const session = await db.gateSession.findUnique({ where: { id: actor.gateSessionId }, select: { revokedAt: true, expiresAt: true } });
  if (session && !session.revokedAt && session.expiresAt > now) return;
  // Una sola fila cada 6 horas por sesión cerrada, no una por petición (la auditoría no se puede purgar).
  if (await firstRejectedNotice(db, actor.gateSessionId, now)) await recordAudit(db, actor, { action: 'gate.session_rejected', organizationId: actor.organizationId, targetType: 'GateSession', targetId: actor.gateSessionId, metadata: { initiativeId: actor.initiativeId } });
  throw new TenantAccessError('GATE_SESSION_OTHER_EVENT');
}

/** Valida un QR y deja entrar `quantity` personas. Dos lecturas simultáneas del mismo pase van una detrás de otra. */
export async function checkInPass(db: KorumPrismaClient, secret: string, actor: SessionActor, event: EventRef, payload: string, quantity: number | 'ASK', now: Date = new Date(), options: CheckInOptions = {}): Promise<CheckInResult> {
  await authorizeTenant(db, actor, event.organizationId, { roles: GATE_ROLES, action: 'gate.check_in', targetType: 'Initiative', targetId: event.initiativeId });
  await assertGateSessionLive(db, actor, now);
  if (quantity !== 'ASK' && (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_PEOPLE_PER_SCAN)) throw new RangeError('El número de personas que entran debe ser un entero positivo.');
  const gateSessionId = actor.kind === 'gate' ? actor.gateSessionId : null;
  // La hora de una lectura sin red es la del móvil, acotada: nunca futura ni anterior a la sesión.
  let scannedAt = now;
  if (options.scannedAt && gateSessionId) {
    const session = await db.gateSession.findUnique({ where: { id: gateSessionId }, select: { createdAt: true } });
    scannedAt = clampScanTime(options.scannedAt.getTime(), now, session?.createdAt ?? now);
  }
  const clientScanId = gateSessionId ? (options.clientScanId ?? null) : null;
  const offline = options.offline === true;

  // Con un lote de 100 QR falsos, una fila por QR llenaría una auditoría que no se puede purgar: una sesión de portería deja una fila por tipo y ventana.
  const noteOnce = async (kind: string) => actor.kind !== 'gate' || (await firstNotice(db, `qr:${kind}:${actor.gateSessionId}`, now));

  const parsed = parsePassQrPayload(payload);
  if (!parsed || !verifyPassSignature(secret, parsed.passUuid, parsed.signature)) {
    if (await noteOnce('invalid')) await recordAudit(db, actor, { action: 'gate.qr_invalid', organizationId: event.organizationId, targetType: 'Initiative', targetId: String(event.initiativeId), metadata: {} });
    return { status: 'INVALID_SIGNATURE' };
  }
  const reference = await db.ticketPass.findUnique({ where: { uuid: parsed.passUuid }, select: { id: true, initiativeId: true, initiative: { select: { organizationId: true } } } });
  // También la entidad: quien tiene cargo en la suya no puede pasar el identificador de un evento ajeno.
  if (!reference || reference.initiativeId !== event.initiativeId || reference.initiative.organizationId !== event.organizationId) {
    // Sin revelar de qué evento o entidad es; el identificador solo queda en la auditoría (una vez por ventana y sesión).
    if (await noteOnce('other_event')) await recordAudit(db, actor, { action: 'gate.qr_other_event', organizationId: event.organizationId, targetType: 'Initiative', targetId: String(event.initiativeId), metadata: { passUuid: parsed.passUuid } });
    return { status: 'OTHER_EVENT' };
  }

  return db.$transaction(async (tx): Promise<CheckInResult> => {
    const pass = await tx.ticketPass.update({
      where: { id: reference.id },
      data: { checkedInCount: { increment: 0 } },
      include: { contribution: { select: { status: true } }, initiative: { select: { status: true } } }
    });
    // Una lectura que ya llegó (la cola se reenvió tras un corte, o se envió desde dos pestañas, o con otra sesión tras cambiar el PIN): se busca en **todas** las
    // sesiones del evento, y el pase ya está bloqueado, así que no hay carrera. Si el móvil reutiliza un identificador, la lectura repetida no cuenta dos veces.
    if (clientScanId !== null) {
      const prior = await tx.ticketCheckIn.findFirst({ where: { clientScanId, ticketPass: { initiativeId: pass.initiativeId } }, select: { accepted: true } });
      if (prior) return { status: 'DUPLICATE_SCAN', accepted: prior.accepted };
    }
    const people = quantity === 'ASK' ? 1 : quantity;
    const record = { ticketPassId: pass.id, gateSessionId, clientScanId, offline, createdAt: scannedAt };
    const reject = async (reason: string) => tx.ticketCheckIn.create({ data: { ...record, quantity: people, accepted: false, reason } });
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
    // Varias plazas libres y sin saber cuántas personas entran: se pregunta, sin dejar entrar ni anotar nada. Con una sola, entra esa persona.
    if (quantity === 'ASK' && remaining > 1) return { status: 'CHOOSE', remaining, quantity: pass.quantity, serialCode: pass.serialCode };
    if (people > remaining) {
      await reject('CANTIDAD_SUPERIOR');
      return { status: 'INSUFFICIENT', remaining, quantity: pass.quantity, firstAccessAt: await firstAccess() };
    }
    await tx.ticketPass.update({ where: { id: pass.id }, data: { checkedInCount: { increment: people }, lastCheckedInAt: pass.lastCheckedInAt && pass.lastCheckedInAt > scannedAt ? pass.lastCheckedInAt : scannedAt } });
    await tx.ticketCheckIn.create({ data: { ...record, quantity: people, accepted: true } });
    return { status: 'ACCEPTED', entered: people, remaining: remaining - people, quantity: pass.quantity, serialCode: pass.serialCode };
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
