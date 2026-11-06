import { randomBytes } from 'node:crypto';
import { dataHmac } from '@/core/security/data-hmac';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { clearAttempts, countAttempts, lastAttemptAt, releaseAttempt, reserveAttempt } from '@/lib/rate-limit';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, type RequestMeta, type SessionActor } from '@/repositories/tenant-guard';
import { generateGatePin, hashGatePin, verifyGatePin } from './gate-pin';

/**
 * Sesiones de portería (QA-SEC06). Cualquier voluntario entra con el PIN del evento, sin cuenta; por eso el PIN es de un solo evento, caduca,
 * y tiene doble límite: 5 fallos por IP y evento en 15 minutos bloquean esa IP, y 20 en el evento revocan el PIN y avisan a los firmantes.
 * El intento se reserva antes de comparar, para que muchos intentos simultáneos no pasen del límite.
 */

export const GATE_PIN_GRACE_MS = 6 * 3_600_000;
export const MAX_FAILURES_PER_IP = 5;
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const MAX_FAILURES_PER_EVENT = 20;
/** Un PIN no vive más de esto, por lejana que se indique la fecha del evento. */
const MAX_PIN_LIFETIME_MS = 365 * 24 * 3_600_000;
const SETTLE_MS = 60_000;

const ipKey = (initiativeId: number, ipHash: string) => `gate-pin:ip:${initiativeId}:${ipHash}`;
const eventKey = (initiativeId: number) => `gate-pin:event:${initiativeId}`;
const hashToken = (secret: string, token: string) => dataHmac(secret, 'gate-session-token', token);

export class GatePinNotAllowedError extends Error {
  constructor(reason: string) {
    super(`No se puede configurar el PIN de portería: ${reason}.`);
    this.name = 'GatePinNotAllowedError';
  }
}

/**
 * Genera el PIN de un evento. Solo lo hacen los firmantes, y se muestra una vez. Las sesiones abiertas con el PIN anterior se cierran:
 * cambiarlo es la forma de echar a alguien que no debería estar dentro.
 */
export async function setGatePin(db: KorumPrismaClient, secret: string, actor: SessionActor, organizationId: string, initiativeId: number, eventEndsAt: Date, now: Date = new Date()): Promise<{ pin: string; expiresAt: Date }> {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'gate.pin_set', targetType: 'Initiative', targetId: initiativeId });
  const initiative = await db.initiative.findUnique({ where: { id: initiativeId }, select: { format: true, organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Initiative', resourceId: initiativeId, resourceLabel: 'Initiative', ownerOrganizationId: initiative?.organizationId ?? null });
  if (initiative?.format !== 'TICKETING') throw new GatePinNotAllowedError('la iniciativa no vende entradas');
  const expiresAt = new Date(eventEndsAt.getTime() + GATE_PIN_GRACE_MS);
  if (expiresAt <= now) throw new GatePinNotAllowedError('el evento ya ha terminado');
  if (expiresAt.getTime() > now.getTime() + MAX_PIN_LIFETIME_MS) throw new GatePinNotAllowedError('la fecha del evento es demasiado lejana');

  const pin = generateGatePin();
  const gatePinHash = await hashGatePin(secret, pin);
  await db.$transaction(async (tx) => {
    await tx.initiative.update({ where: { id: initiativeId }, data: { gatePinHash, gatePinExpiresAt: expiresAt } });
    const closed = await tx.gateSession.updateMany({ where: { initiativeId, revokedAt: null }, data: { revokedAt: now } });
    await clearAttempts(tx, eventKey(initiativeId));
    // Con un PIN nuevo, los fallos con el anterior no deben dejar fuera a los voluntarios de la misma wifi.
    await tx.rateLimit.deleteMany({ where: { key: { startsWith: ipKey(initiativeId, '') } } });
    await tx.auditLog.create({
      data: { actorType: 'USER', actorUserId: actor.kind === 'user' ? actor.userId : null, organizationId, action: 'gate.pin_set', targetType: 'Initiative', targetId: String(initiativeId), metadataJson: { expiresAt: expiresAt.toISOString(), sessionsClosed: closed.count } }
    });
  });
  return { pin, expiresAt };
}

export type OpenGateSessionResult =
  | { status: 'OPENED'; token: string; gateSessionId: string; expiresAt: Date }
  /** PIN incorrecto, caducado o evento inexistente: la respuesta es la misma (el tiempo de respuesta sí varía; aceptado, ver la bitácora del 2.3). */
  | { status: 'INVALID' }
  | { status: 'LOCKED' };

async function auditAttempt(db: Db, organizationId: string, initiativeId: number, action: string, meta: RequestMeta | undefined, extra: Record<string, string | number> = {}): Promise<void> {
  await db.auditLog.create({ data: { actorType: 'GATE_SESSION', organizationId, action, targetType: 'Initiative', targetId: String(initiativeId), ipHash: meta?.ipHash?.slice(0, 128) ?? null, metadataJson: extra } });
}

/** Revoca el PIN tras demasiados fallos y avisa a los firmantes. Las sesiones ya abiertas siguen: la puerta no debe pararse por un ataque. */
async function revokePinAfterAbuse(db: KorumPrismaClient, initiativeId: number, organizationId: string, pinHash: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const { count } = await tx.initiative.updateMany({ where: { id: initiativeId, gatePinHash: pinHash }, data: { gatePinHash: null, gatePinExpiresAt: null } });
    if (count === 0) return;
    await auditAttempt(tx, organizationId, initiativeId, 'gate.pin_revoked', undefined, { failures: MAX_FAILURES_PER_EVENT });
    const signers = await tx.organizationMember.findMany({ where: { organizationId, role: { in: [...SIGNER_ROLES] }, user: { gdprAnonymizedAt: null } }, select: { userId: true, user: { select: { email: true, locale: true } } } });
    for (const signer of signers) {
      await tx.outboxMessage.create({
        data: {
          idempotencyKey: `gate.pinRevoked:${initiativeId}:${pinHash.slice(-16)}:${signer.userId}`,
          templateKey: 'gate.pinRevoked',
          locale: signer.user.locale,
          toAddress: signer.user.email,
          userId: signer.userId,
          organizationId,
          payloadJson: { initiativeId }
        }
      });
    }
  });
}

/** Un voluntario teclea el PIN. El resultado nunca dice qué ha fallado, y todo intento queda en `AuditLog`. */
export async function openGateSession(db: KorumPrismaClient, secret: string, input: { initiativeId: number; pin: string; deviceLabel?: string; requestMeta?: RequestMeta }, now: Date = new Date()): Promise<OpenGateSessionResult> {
  const { initiativeId, pin, requestMeta } = input;
  // Sin IP válida, todos van al mismo grupo: es más estricto, nunca más permisivo.
  const ip = ipKey(initiativeId, requestMeta?.ipHash ?? 'unknown-ip');
  const initiative = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true } });
  // Sin escribir nada: recorrer identificadores que no existen no debe llenar tablas que no se pueden purgar.
  if (!initiative) return { status: 'INVALID' };
  const { organizationId } = initiative;

  if (!(await reserveAttempt(db, ip, { limit: MAX_FAILURES_PER_IP, windowMs: FAILURE_WINDOW_MS }, now))) {
    await auditAttempt(db, organizationId, initiativeId, 'gate.pin_blocked', requestMeta);
    return { status: 'LOCKED' };
  }
  const current = await db.initiative.findUnique({ where: { id: initiativeId }, select: { gatePinHash: true, gatePinExpiresAt: true } });
  if (!current?.gatePinHash || !current.gatePinExpiresAt || current.gatePinExpiresAt <= now || !/^\d{6}$/.test(pin)) {
    await auditAttempt(db, organizationId, initiativeId, 'gate.pin_failed', requestMeta, { cause: 'NOT_AVAILABLE' });
    return { status: 'INVALID' };
  }
  const event = eventKey(initiativeId);
  if (!(await reserveAttempt(db, event, { limit: MAX_FAILURES_PER_EVENT, windowMs: null }, now))) {
    await auditAttempt(db, organizationId, initiativeId, 'gate.pin_blocked', requestMeta, { cause: 'EVENT_LIMIT' });
    // Si falló la revocación del intento anterior, se completa ahora: el PIN no puede quedar bloqueado sin que nadie lo sepa. Solo pasado
    // un minuto: antes, parte de las reservas pueden ser voluntarios entrando con el PIN correcto, no fallos.
    const last = await lastAttemptAt(db, event);
    if (last !== null && now.getTime() - last >= SETTLE_MS) await revokePinAfterAbuse(db, initiativeId, organizationId, current.gatePinHash);
    return { status: 'LOCKED' };
  }

  const pinHash = current.gatePinHash;
  if (!(await verifyGatePin(secret, pin, pinHash))) {
    await auditAttempt(db, organizationId, initiativeId, 'gate.pin_failed', requestMeta, { cause: 'WRONG_PIN' });
    if ((await countAttempts(db, event)) >= MAX_FAILURES_PER_EVENT) await revokePinAfterAbuse(db, initiativeId, organizationId, pinHash);
    return { status: 'INVALID' };
  }

  await releaseAttempt(db, ip);
  await releaseAttempt(db, event);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = current.gatePinExpiresAt;
  const session = await db.$transaction(async (tx) => {
    // Entre comparar y crear la sesión el PIN ha podido cambiar o revocarse: entonces esta sesión no debe nacer.
    const { count } = await tx.initiative.updateMany({ where: { id: initiativeId, gatePinHash: pinHash, gatePinExpiresAt: { gt: now } }, data: { ticketsHeld: { increment: 0 } } });
    if (count === 0) return null;
    const created = await tx.gateSession.create({ data: { initiativeId, tokenHash: hashToken(secret, token), deviceLabel: input.deviceLabel?.slice(0, 80) ?? null, createdAt: now, expiresAt } });
    await auditAttempt(tx, organizationId, initiativeId, 'gate.session_opened', requestMeta, { gateSessionId: created.id });
    return created;
  });
  return session ? { status: 'OPENED', token, gateSessionId: session.id, expiresAt } : { status: 'INVALID' };
}

/** Traduce el token de la cookie al actor de portería. `null` si ya no vale. */
export async function resolveGateSession(db: Db, secret: string, token: string, requestMeta?: RequestMeta, now: Date = new Date()): Promise<Extract<SessionActor, { kind: 'gate' }> | null> {
  const session = await db.gateSession.findUnique({ where: { tokenHash: hashToken(secret, token) }, select: { id: true, initiativeId: true, expiresAt: true, revokedAt: true, initiative: { select: { organizationId: true } } } });
  if (!session) return null;
  if (session.revokedAt) {
    // Un voluntario expulsado que reintenta. Los tokens desconocidos no se registran: sería otra vía de llenar una tabla que no se purga.
    await db.auditLog.create({ data: { actorType: 'GATE_SESSION', organizationId: session.initiative.organizationId, action: 'gate.session_rejected', targetType: 'GateSession', targetId: session.id, ipHash: requestMeta?.ipHash?.slice(0, 128) ?? null, metadataJson: { initiativeId: session.initiativeId } } });
    return null;
  }
  if (session.expiresAt <= now) return null;
  return { kind: 'gate', gateSessionId: session.id, organizationId: session.initiative.organizationId, initiativeId: session.initiativeId, requestMeta };
}

/** La entidad cierra una sesión de portería desde el panel. */
export async function revokeGateSession(db: KorumPrismaClient, actor: SessionActor, organizationId: string, gateSessionId: string, now: Date = new Date()): Promise<void> {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'gate.session_revoke', targetType: 'GateSession', targetId: gateSessionId });
  const session = await db.gateSession.findUnique({ where: { id: gateSessionId }, select: { initiativeId: true, initiative: { select: { organizationId: true } } } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'GateSession', resourceId: gateSessionId, resourceLabel: 'GateSession', ownerOrganizationId: session?.initiative.organizationId ?? null });
  await db.$transaction(async (tx) => {
    await tx.gateSession.updateMany({ where: { id: gateSessionId, revokedAt: null }, data: { revokedAt: now } });
    await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: actor.kind === 'user' ? actor.userId : null, organizationId, action: 'gate.session_revoked', targetType: 'GateSession', targetId: gateSessionId, metadataJson: { initiativeId: session!.initiativeId } } });
  });
}

/** El voluntario cierra la portería en su móvil: la sesión deja de valer en el servidor, no solo se borra la cookie (auditoría del 3.2, M8). */
export async function closeGateSessionByToken(db: Db, secret: string, token: string, now: Date = new Date()): Promise<void> {
  await db.gateSession.updateMany({ where: { tokenHash: hashToken(secret, token), revokedAt: null }, data: { revokedAt: now } });
}
