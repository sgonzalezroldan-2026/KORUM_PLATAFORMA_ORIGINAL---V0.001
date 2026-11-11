import { randomBytes } from 'node:crypto';
import { dataHmac } from '@/core/security/data-hmac';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { clearAttempts, countAttempts, lastAttemptAt, releaseAttempt, reserveAttempt } from '@/lib/rate-limit';
import { GATE_ENTRY_RULE } from '@/lib/rate-limit-rules';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, type RequestMeta, type SessionActor } from '@/repositories/tenant-guard';
import { generateGateCode } from './gate-code';
import { firstNotice, firstRejectedNotice, ipOf } from './gate-limits';
import { generateGatePin, hashGatePin, verifyGatePin } from './gate-pin';
import { GATE_SESSION_MAX_MS, gatePinExpiry } from './gate-rules';

export { GATE_PIN_GRACE_MS } from './gate-rules';

/**
 * Sesiones de portería (QA-SEC06). Cualquier voluntario entra con el PIN del evento, sin cuenta; por eso el PIN es de un solo evento, caduca,
 * y tiene tres límites: 60 intentos por red en 15 minutos en **todos** los eventos (antes de escribir nada más), 5 fallos por IP y evento (bloquean esa red 6 minutos), y 25
 * en el evento, que revocan el PIN y avisan a los firmantes. Cada bloqueo deja una sola fila de auditoría por ventana.
 * El intento se reserva antes de comparar, para que muchos intentos simultáneos no pasen del límite.
 */

export const MAX_FAILURES_PER_IP = 5;
/** Un bloqueo por 5 fallos dura 6 minutos (decisión del promotor, 2026-11-11): el resto de redes sigue entrando y la cola de la puerta no se paraliza. */
export const FAILURE_WINDOW_MS = 6 * 60_000;
/** Con 25 fallos acumulados en el evento (desde cualquier red) el PIN se revoca y se avisa a quienes firman. */
export const MAX_FAILURES_PER_EVENT = 25;
/** Un PIN no vive más de esto, por lejana que sea la fecha del evento. */
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
 * Genera el PIN de un evento. Solo lo hacen los firmantes, y se muestra una vez. Vale hasta 6 horas después de acabar el día del evento. Las sesiones abiertas con el PIN anterior se cierran:
 * cambiarlo es la forma de echar a alguien que no debería estar dentro.
 */
export async function setGatePin(db: KorumPrismaClient, secret: string, actor: SessionActor, organizationId: string, initiativeId: number, now: Date = new Date()): Promise<{ pin: string; expiresAt: Date }> {
  // Solo quien firma: el Super-Admin ve la pantalla pero no crea PIN (con él podría entrar en la puerta y sortear una rifa).
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'gate.pin_set', targetType: 'Initiative', targetId: initiativeId, allowSuperadmin: false });
  const initiative = await db.initiative.findUnique({ where: { id: initiativeId }, select: { format: true, status: true, organizationId: true, closesAt: true, gateCode: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Initiative', resourceId: initiativeId, resourceLabel: 'Initiative', ownerOrganizationId: initiative?.organizationId ?? null });
  if (initiative?.format !== 'TICKETING') throw new GatePinNotAllowedError('la iniciativa no vende entradas');
  if (initiative.status !== 'FUNDRAISING' && initiative.status !== 'GOAL_REACHED') throw new GatePinNotAllowedError('la iniciativa no está a la venta');
  // La caducidad sale de la fecha del evento guardada en la iniciativa, no de lo que indique quien llama (QA-SEC09).
  const expiresAt = gatePinExpiry(initiative.closesAt);
  if (expiresAt <= now) throw new GatePinNotAllowedError('el evento ya ha terminado');
  if (expiresAt.getTime() > now.getTime() + MAX_PIN_LIFETIME_MS) throw new GatePinNotAllowedError('la fecha del evento es demasiado lejana');

  const pin = generateGatePin();
  const gatePinHash = await hashGatePin(secret, pin);
  await db.$transaction(async (tx) => {
    await tx.initiative.update({ where: { id: initiativeId }, data: { gatePinHash, gatePinExpiresAt: expiresAt, gateCode: initiative.gateCode ?? generateGateCode() } });
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

/**
 * Cambia el código de la puerta de un evento (el enlace de la portería), por si el enlace se filtró: el anterior deja de abrir nada y de poder probar PINs. Solo quien firma.
 * Los móviles que ya están dentro siguen funcionando (su sesión no depende del enlace), pero si recargan la página tendrán que abrir el enlace nuevo.
 */
export async function rotateGateCode(db: KorumPrismaClient, actor: SessionActor, organizationId: string, initiativeId: number): Promise<{ gateCode: string }> {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'gate.code_rotate', targetType: 'Initiative', targetId: initiativeId, allowSuperadmin: false });
  const initiative = await db.initiative.findUnique({ where: { id: initiativeId }, select: { format: true, status: true, organizationId: true, gateCode: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Initiative', resourceId: initiativeId, resourceLabel: 'Initiative', ownerOrganizationId: initiative?.organizationId ?? null });
  if (initiative?.format !== 'TICKETING' || (initiative.status !== 'FUNDRAISING' && initiative.status !== 'GOAL_REACHED')) throw new GatePinNotAllowedError('la iniciativa no está a la venta');
  if (initiative.gateCode === null) throw new GatePinNotAllowedError('todavía no hay PIN ni enlace');
  const gateCode = generateGateCode();
  await db.$transaction(async (tx) => {
    await tx.initiative.update({ where: { id: initiativeId }, data: { gateCode } });
    await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: actor.kind === 'user' ? actor.userId : null, organizationId, action: 'gate.code_rotated', targetType: 'Initiative', targetId: String(initiativeId), metadataJson: {} } });
  });
  return { gateCode };
}

export type OpenGateSessionResult =
  | { status: 'OPENED'; token: string; gateSessionId: string; expiresAt: Date }
  /** PIN incorrecto, caducado o evento inexistente: la respuesta es la misma (el tiempo de respuesta sí varía; aceptado, ver la bitácora del 2.3). */
  | { status: 'INVALID'; outboxIds?: number[] }
  /** `outboxIds`: los avisos de PIN anulado que acaba de crear este intento, para enviarlos al momento (no a las 02:00 de la tarea diaria). */
  | { status: 'LOCKED'; outboxIds?: number[] };

async function auditAttempt(db: Db, organizationId: string, initiativeId: number, action: string, meta: RequestMeta | undefined, extra: Record<string, string | number> = {}): Promise<void> {
  await db.auditLog.create({ data: { actorType: 'GATE_SESSION', organizationId, action, targetType: 'Initiative', targetId: String(initiativeId), ipHash: meta?.ipHash?.slice(0, 128) ?? null, metadataJson: extra } });
}

/** Revoca el PIN tras demasiados fallos y avisa a los firmantes. Las sesiones ya abiertas siguen: la puerta no debe pararse por un ataque. */
async function revokePinAfterAbuse(db: KorumPrismaClient, initiativeId: number, organizationId: string, pinHash: string): Promise<number[]> {
  return db.$transaction(async (tx) => {
    const ids: number[] = [];
    const { count } = await tx.initiative.updateMany({ where: { id: initiativeId, gatePinHash: pinHash }, data: { gatePinHash: null, gatePinExpiresAt: null } });
    if (count === 0) return ids;
    await auditAttempt(tx, organizationId, initiativeId, 'gate.pin_revoked', undefined, { failures: MAX_FAILURES_PER_EVENT });
    const signers = await tx.organizationMember.findMany({ where: { organizationId, role: { in: [...SIGNER_ROLES] }, user: { gdprAnonymizedAt: null, isSuperadmin: false } }, select: { userId: true, user: { select: { email: true, locale: true } } } });
    for (const signer of signers) {
      const row = await tx.outboxMessage.create({
        select: { id: true },
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
      ids.push(row.id);
    }
    return ids;
  });
}

/** Un voluntario teclea el PIN. El resultado nunca dice qué ha fallado, y todo intento queda en `AuditLog`. */
export async function openGateSession(db: KorumPrismaClient, secret: string, input: { initiativeId: number; pin: string; deviceLabel?: string; requestMeta?: RequestMeta }, now: Date = new Date()): Promise<OpenGateSessionResult> {
  const { initiativeId, pin, requestMeta } = input;
  // Sin IP válida, todos van al mismo grupo: es más estricto, nunca más permisivo.
  const network = ipOf(requestMeta);
  const ip = ipKey(initiativeId, network);
  // Límite global de la red, en todos los eventos y antes de leer nada: lo único que escribe es su propio contador (QA-SEC09). Una entrada correcta lo devuelve.
  const entryKey = `${GATE_ENTRY_RULE.prefix}${network}`;
  if (!(await reserveAttempt(db, entryKey, GATE_ENTRY_RULE, now))) {
    if (await firstNotice(db, `entry:${network}`, now)) {
      await db.auditLog.create({ data: { actorType: 'GATE_SESSION', action: 'gate.pin_blocked', targetType: 'Gate', targetId: 'entry', ipHash: requestMeta?.ipHash?.slice(0, 128) ?? null, metadataJson: { cause: 'NETWORK_LIMIT', limit: GATE_ENTRY_RULE.limit } } });
    }
    return { status: 'LOCKED' };
  }
  const initiative = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true, format: true } });
  // Sin escribir nada: recorrer identificadores que no existen, o que no son de taquilla, no debe llenar tablas que no se pueden purgar.
  if (!initiative || initiative.format !== 'TICKETING') return { status: 'INVALID' };
  const { organizationId } = initiative;

  if (!(await reserveAttempt(db, ip, { limit: MAX_FAILURES_PER_IP, windowMs: FAILURE_WINDOW_MS }, now))) {
    // Solo el primer bloqueo de cada ventana y evento queda en la auditoría: una red bloqueada que insiste no escribe una fila por petición.
    if (await firstNotice(db, `pin:${initiativeId}`, now)) await auditAttempt(db, organizationId, initiativeId, 'gate.pin_blocked', requestMeta);
    return { status: 'LOCKED' };
  }
  const current = await db.initiative.findUnique({ where: { id: initiativeId }, select: { gatePinHash: true, gatePinExpiresAt: true } });
  if (!current?.gatePinHash || !current.gatePinExpiresAt || current.gatePinExpiresAt <= now || !/^\d{6}$/.test(pin)) {
    // Un evento sin PIN vigente (o revocado) no tiene el tope de 25 fallos: una fila por **evento** y ventana (no por red: con un bloque IPv6 hay miles de redes), no una por intento.
    if (await firstNotice(db, `na:${initiativeId}`, now)) await auditAttempt(db, organizationId, initiativeId, 'gate.pin_failed', requestMeta, { cause: 'NOT_AVAILABLE' });
    return { status: 'INVALID' };
  }
  const event = eventKey(initiativeId);
  if (!(await reserveAttempt(db, event, { limit: MAX_FAILURES_PER_EVENT, windowMs: null }, now))) {
    if (await firstNotice(db, `event:${initiativeId}`, now)) await auditAttempt(db, organizationId, initiativeId, 'gate.pin_blocked', requestMeta, { cause: 'EVENT_LIMIT' });
    // Si falló la revocación del intento anterior, se completa ahora: el PIN no puede quedar bloqueado sin que nadie lo sepa. Solo pasado
    // un minuto: antes, parte de las reservas pueden ser voluntarios entrando con el PIN correcto, no fallos.
    const last = await lastAttemptAt(db, event);
    const ids = last !== null && now.getTime() - last >= SETTLE_MS ? await revokePinAfterAbuse(db, initiativeId, organizationId, current.gatePinHash) : [];
    return ids.length > 0 ? { status: 'LOCKED', outboxIds: ids } : { status: 'LOCKED' };
  }

  const pinHash = current.gatePinHash;
  if (!(await verifyGatePin(secret, pin, pinHash))) {
    await auditAttempt(db, organizationId, initiativeId, 'gate.pin_failed', requestMeta, { cause: 'WRONG_PIN' });
    const ids = (await countAttempts(db, event)) >= MAX_FAILURES_PER_EVENT ? await revokePinAfterAbuse(db, initiativeId, organizationId, pinHash) : [];
    return ids.length > 0 ? { status: 'INVALID', outboxIds: ids } : { status: 'INVALID' };
  }

  await releaseAttempt(db, ip);
  await releaseAttempt(db, event);
  // El límite global de la red (`entryKey`) **no** se devuelve al acertar: quien tiene el PIN (se comparte por WhatsApp) podría abrir sesiones en bucle y cada una deja
  // una fila de auditoría. 60 entradas cada 15 minutos por red sobran para los voluntarios de un colegio.
  const token = randomBytes(32).toString('base64url');
  // La sesión no vive más de 48 h aunque el PIN dure semanas: un PIN generado al publicar no deja sesiones abiertas hasta el evento.
  const expiresAt = new Date(Math.min(current.gatePinExpiresAt.getTime(), now.getTime() + GATE_SESSION_MAX_MS));
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
    // Un voluntario expulsado que reintenta. Los tokens desconocidos no se registran (sería otra vía de llenar una tabla que no se purga) y una sesión cerrada
    // deja una sola fila cada 6 horas, no una por petición.
    if (await firstRejectedNotice(db, session.id, now)) await db.auditLog.create({ data: { actorType: 'GATE_SESSION', organizationId: session.initiative.organizationId, action: 'gate.session_rejected', targetType: 'GateSession', targetId: session.id, ipHash: requestMeta?.ipHash?.slice(0, 128) ?? null, metadataJson: { initiativeId: session.initiativeId } } });
    return null;
  }
  if (session.expiresAt <= now) return null;
  return { kind: 'gate', gateSessionId: session.id, organizationId: session.initiative.organizationId, initiativeId: session.initiativeId, requestMeta };
}

/** La entidad cierra una sesión de portería desde el panel. */
export async function revokeGateSession(db: KorumPrismaClient, actor: SessionActor, organizationId: string, gateSessionId: string, now: Date = new Date()): Promise<void> {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'gate.session_revoke', targetType: 'GateSession', targetId: gateSessionId, allowSuperadmin: false });
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
