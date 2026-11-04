import { dataHmac, HMAC_PURPOSE } from '@/core/security/crypto';
import { normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import type { PrivacyRequestStatus, PrivacyRequestType } from '@/generated/prisma/enums';
import { assertVerifiedActor, type VerifiedAccountActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import type { Db } from '@/lib/db';
import { writeAudit } from '@/services/audit/audit.service';

/**
 * Solicitudes de derechos RGPD (`PrivacyRequest`): acceso, exportación, rectificación, supresión y oposición. El plazo legal de respuesta
 * es de **un mes** desde la solicitud (RGPD art. 12.3): `dueAt` lo fija y la purga semanal avisa al Super-Admin de las vencidas. El email
 * de quien la pide solo se guarda como HMAC: basta para relacionar solicitudes, y no deja un email en claro de alguien que pide ser borrado.
 */

export class PrivacyRequestError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'ALREADY_CLOSED') {
    // Una solicitud de otra persona responde igual que una que no existe: no se revela que existe.
    super(code === 'NOT_FOUND' ? 'La solicitud no existe' : 'La solicitud ya está cerrada');
    this.name = 'PrivacyRequestError';
  }
}

/** Mismo día del mes siguiente (o el último día, si no existe: 31 de enero → 28 o 29 de febrero), en UTC. */
export function oneMonthAfter(date: Date): Date {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

export const privacyEmailHmac = (hmacSecret: string, email: string) => dataHmac(hmacSecret, HMAC_PURPOSE.privacyEmail, normalizeCanonicalEmail(email));

/** La abre la propia persona, reautenticada: un identificador suelto permitiría abrir solicitudes a nombre de otra. */
export async function openPrivacyRequest(db: Db, hmacSecret: string, input: { actor: VerifiedAccountActor; type: PrivacyRequestType; notes?: string }, now: Date = new Date()) {
  assertVerifiedActor(input.actor, 'verified-account', 'privacy.request_open', now);
  const userId = input.actor.userId;
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  const request = await db.privacyRequest.create({
    data: { userId, requesterEmailHmac: privacyEmailHmac(hmacSecret, user.email), type: input.type, status: 'RECEIVED', dueAt: oneMonthAfter(now), notes: input.notes ?? null, createdAt: now }
  });
  await writeAudit(db, { actorType: 'USER', actorUserId: userId, action: 'privacy.request_opened', targetType: 'PrivacyRequest', targetId: String(request.id), metadata: { type: input.type } });
  return request;
}

/** Quién cierra: la propia persona (solo las suyas, p. ej. al descargar su exportación), el Super-Admin o el sistema. */
export type PrivacyRequestCloser = { kind: 'self'; actor: VerifiedAccountActor } | { kind: 'superadmin'; actor: VerifiedSuperadminActor } | { kind: 'system' };

const OPEN_STATUSES: readonly PrivacyRequestStatus[] = ['RECEIVED', 'IN_PROGRESS'];

/** Cierra una solicitud abierta (`COMPLETED` o `REJECTED`). `notes` es interno: sin datos personales. */
export async function closePrivacyRequest(db: Db, requestId: number, outcome: { status: 'COMPLETED' | 'REJECTED'; notes?: string }, closer: PrivacyRequestCloser, now: Date = new Date()): Promise<void> {
  if (closer.kind === 'self') assertVerifiedActor(closer.actor, 'verified-account', 'privacy.request_close', now);
  if (closer.kind === 'superadmin') assertVerifiedActor(closer.actor, 'verified-superadmin', 'privacy.request_close', now);
  const request = await db.privacyRequest.findUnique({ where: { id: requestId }, select: { status: true, type: true, userId: true } });
  if (!request || (closer.kind === 'self' && request.userId !== closer.actor.userId)) throw new PrivacyRequestError('NOT_FOUND');
  if (!OPEN_STATUSES.includes(request.status)) throw new PrivacyRequestError('ALREADY_CLOSED');
  const { count } = await db.privacyRequest.updateMany({ where: { id: requestId, status: { in: [...OPEN_STATUSES] } }, data: { status: outcome.status, completedAt: now, ...(outcome.notes ? { notes: outcome.notes } : {}) } });
  if (count === 0) throw new PrivacyRequestError('ALREADY_CLOSED');
  await writeAudit(db, {
    actorType: closer.kind === 'system' ? 'SYSTEM' : 'USER',
    actorUserId: closer.kind === 'system' ? null : closer.actor.userId,
    action: 'privacy.request_closed',
    targetType: 'PrivacyRequest',
    targetId: String(requestId),
    metadata: { type: request.type, status: outcome.status }
  });
}

/** Solicitudes abiertas con el plazo vencido, para la alerta de la consola. */
export function overduePrivacyRequests(db: Db, now: Date, limit: number) {
  return db.privacyRequest.findMany({ where: { status: { in: [...OPEN_STATUSES] }, dueAt: { lt: now } }, orderBy: { dueAt: 'asc' }, take: limit, select: { id: true, type: true, dueAt: true } });
}
