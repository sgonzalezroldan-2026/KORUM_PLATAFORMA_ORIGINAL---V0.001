import { directEmailSchema, rectificationCloseSchema, rectifyNameSchema } from '@/core/admin/console-support-rules';
import { notifySigners } from '@/core/jobs/notify';
import { closePrivacyRequest, PrivacyRequestError } from '@/core/privacy/privacy-requests';
import { dataHmac } from '@/core/security/crypto';
import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { answerTicketSchema, planTicketAnswer, type AnswerRejection, type InboxStatus } from '@/core/support/support-inbox-rules';
import { isLocale, routing } from '@/i18n/routing';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { releaseAttempt, reserveAttempt } from '@/lib/rate-limit';
import { CONSOLE_DIRECT_EMAIL_PERSON_RULE, CONSOLE_DIRECT_EMAIL_RULE } from '@/lib/rate-limit-rules';
import { recordAudit, type RequestMeta, type SessionActor } from '@/repositories/tenant-guard';
import { writeAudit } from '@/services/audit/audit.service';
import { authorizeConsoleSession } from './console-alerts.service';
import { auditWho } from './global-rules.service';

/**
 * Bandeja de soporte de KORUM en la consola (Sprint 5.3, prototipo `sa-sub-tickets`). El Super-Admin contesta las consultas dirigidas a la plataforma
 * (`target = SUPERADMIN`: pagos, cuenta, rectificación y otras) y las que las entidades escriben a KORUM desde su panel (`fromOrganization`, prioritarias).
 * Mismas reglas que la bandeja del centro: **una sola respuesta por consulta**, el estado solo avanza y el aviso por email **no copia la respuesta** (se lee en
 * la cuenta o en el panel). A diferencia de la bandeja del centro, KORUM sí ve el email de quien escribe: lo necesita para rectificar datos o escribirle.
 * Las consultas dirigidas a un centro (`target = ORGANIZATION`) **no son de KORUM**: aquí no se listan ni se pueden contestar.
 */

export interface ConsoleTicket {
  ticketCode: string;
  origin: string;
  orgSlug: string | null;
  fromOrganization: boolean;
  topic: string;
  subject: string;
  message: string;
  status: InboxStatus;
  replyMessage: string | null;
  senderEmail: string | null;
  createdAt: string;
  repliedAt: string | null;
  resolvedAt: string | null;
  /** ¿Hay una cuenta viva a la que avisar de la respuesta? Si no, la respuesta se guarda pero nadie recibe el aviso (y no hay segunda respuesta). */
  canNotify: boolean;
  /** Solo `RECTIFICATION`: el nombre actual de la cuenta, para poder compararlo con el correcto. */
  accountName: string | null;
  /** Solo `RECTIFICATION`: la solicitud RGPD que abrió la consulta y su plazo de un mes. */
  rectification: { requestId: number; status: string; dueAt: string; overdue: boolean } | null;
}

export interface ConsoleSupportView {
  waiting: ConsoleTicket[];
  resolved: ConsoleTicket[];
  waitingCount: number;
  /** Las que escribe una entidad desde su panel y siguen sin resolver: se leen primero. */
  priorityCount: number;
}

const WAITING_LIMIT = 100;
const RESOLVED_LIMIT = 20;

const SELECT = {
  id: true,
  ticketCode: true,
  originLabel: true,
  fromOrganization: true,
  topic: true,
  subject: true,
  message: true,
  status: true,
  replyMessage: true,
  senderEmail: true,
  createdAt: true,
  repliedAt: true,
  resolvedAt: true,
  organization: { select: { slug: true } }
} as const;

const platformTickets = { target: 'SUPERADMIN' } as const;

/**
 * La solicitud RGPD de una consulta se enlaza por su nota exacta: `Soporte TCK-…` al abrirla y `Soporte TCK-…: nota` al cerrarla. Con «contiene», una nota que nombrara otra
 * consulta (`ver Soporte TCK-BBBBBB`) haría que la consulta B mostrara la solicitud de A (auditoría de seguridad del 5.3, M4).
 */
const requestNoteOf = (code: string) => `Soporte ${code}`;
const isNoteOf = (notes: string | null, code: string) => notes !== null && (notes === requestNoteOf(code) || notes.startsWith(`${requestNoteOf(code)}: `));
const noteWhere = (code: string) => ({ OR: [{ notes: requestNoteOf(code) }, { notes: { startsWith: `${requestNoteOf(code)}: ` } }] });
const WAITING = ['OPEN', 'IN_PROGRESS'] as const;

export async function loadConsoleSupport(db: KorumPrismaClient, now: Date = new Date()): Promise<ConsoleSupportView> {
  const [waiting, resolved, waitingCount, priorityCount] = await Promise.all([
    // Primero las de las entidades (prioritarias) y, dentro de cada grupo, las más antiguas.
    db.supportTicket.findMany({ where: { ...platformTickets, status: { in: [...WAITING] } }, orderBy: [{ fromOrganization: 'desc' }, { id: 'asc' }], take: WAITING_LIMIT, select: SELECT }),
    db.supportTicket.findMany({ where: { ...platformTickets, status: 'RESOLVED' }, orderBy: { resolvedAt: 'desc' }, take: RESOLVED_LIMIT, select: SELECT }),
    db.supportTicket.count({ where: { ...platformTickets, status: { in: [...WAITING] } } }),
    db.supportTicket.count({ where: { ...platformTickets, fromOrganization: true, status: { in: [...WAITING] } } })
  ]);
  const rows = [...waiting, ...resolved];
  // Las solicitudes de rectificación de las consultas visibles (se enlazan por el código, que va en sus notas internas).
  const rectificationCodes = rows.filter((row) => row.topic === 'RECTIFICATION').map((row) => row.ticketCode);
  const requests =
    rectificationCodes.length === 0
      ? []
      : await db.privacyRequest.findMany({ where: { type: 'RECTIFICATION', OR: rectificationCodes.map((code) => noteWhere(code)) }, select: { id: true, status: true, dueAt: true, notes: true } });
  const emails = [...new Set(rows.flatMap((row) => (row.senderEmail ? [row.senderEmail] : [])))];
  const accounts = emails.length === 0 ? [] : await db.user.findMany({ where: { email: { in: emails }, gdprAnonymizedAt: null }, select: { email: true, name: true } });
  const view = (row: (typeof rows)[number]): ConsoleTicket => {
    const account = row.senderEmail ? accounts.find((candidate) => candidate.email === row.senderEmail) : undefined;
    const request = row.topic === 'RECTIFICATION' ? requests.find((candidate) => isNoteOf(candidate.notes, row.ticketCode)) : undefined;
    return {
      ticketCode: row.ticketCode,
      origin: row.originLabel,
      orgSlug: row.organization?.slug ?? null,
      fromOrganization: row.fromOrganization,
      topic: row.topic,
      subject: row.subject,
      message: row.message,
      status: row.status,
      replyMessage: row.replyMessage,
      senderEmail: row.senderEmail,
      canNotify: account !== undefined,
      accountName: row.topic === 'RECTIFICATION' ? (account?.name ?? null) : null,
      createdAt: row.createdAt.toISOString(),
      repliedAt: row.repliedAt?.toISOString() ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      rectification: request ? { requestId: request.id, status: request.status, dueAt: request.dueAt.toISOString(), overdue: (request.status === 'RECEIVED' || request.status === 'IN_PROGRESS') && request.dueAt < now } : null
    };
  };
  return { waiting: waiting.map(view), resolved: resolved.map(view), waitingCount, priorityCount };
}

export type PlatformAnswerOutcome = { status: 'OK'; ticketCode: string; resolved: boolean; outboxId: number | null } | { status: 'REJECTED'; reason: AnswerRejection };

/** Contestar y/o cambiar el estado de una consulta dirigida a KORUM. Basta el Super-Admin con su segundo factor de esta sesión: no mueve dinero. */
export async function answerPlatformTicket(db: KorumPrismaClient, actor: SessionActor, payload: unknown, now: Date = new Date()): Promise<PlatformAnswerOutcome> {
  await authorizeConsoleSession(db, actor, 'support.platform_answer', 'SupportTicket');
  const parsed = answerTicketSchema.safeParse(payload);
  if (!parsed.success) return { status: 'REJECTED', reason: 'INVALID_INPUT' };
  const input = parsed.data;
  return inTransaction(db, async (tx): Promise<PlatformAnswerOutcome> => {
    const ticket = await tx.supportTicket.findFirst({
      where: { ticketCode: input.ticketCode, ...platformTickets },
      select: { id: true, status: true, replyMessage: true, senderEmail: true, message: true, fromOrganization: true, organizationId: true, organization: { select: { slug: true } } }
    });
    if (!ticket) return { status: 'REJECTED', reason: 'NOT_FOUND' };
    // Una consulta cuyo texto ya se borró (cuenta suprimida o plazo de conservación) no se contesta: nadie leería la respuesta.
    if (ticket.message === '') return { status: 'REJECTED', reason: 'PURGED' };
    const plan = planTicketAnswer({ status: ticket.status, hasReply: ticket.replyMessage !== null }, { reply: input.reply, status: input.status });
    if (!plan.ok) return { status: 'REJECTED', reason: plan.reason };

    // Escritura condicional: dos sesiones a la vez no se pisan (la segunda ve el estado nuevo y se rechaza).
    const resolving = plan.nextStatus === 'RESOLVED';
    const { count } = await tx.supportTicket.updateMany({
      where: { id: ticket.id, status: ticket.status, ...(plan.reply === null ? {} : { replyMessage: null }) },
      data: { status: plan.nextStatus, updatedAt: now, ...(plan.reply === null ? {} : { replyMessage: plan.reply, repliedAt: now }), ...(resolving ? { resolvedAt: now } : {}) }
    });
    if (count !== 1) return { status: 'REJECTED', reason: 'CONFLICT' };
    // Nunca el texto de la respuesta ni el email: solo qué se hizo.
    await recordAudit(tx, actor, { action: 'support.platform_answered', organizationId: ticket.fromOrganization ? ticket.organizationId : null, targetType: 'SupportTicket', targetId: String(ticket.id), metadata: { ticketCode: input.ticketCode, replied: plan.reply !== null, from: ticket.status, to: plan.nextStatus } }, { required: true });

    let outboxId: number | null = null;
    if (plan.reply !== null && ticket.senderEmail) {
      const recipient = await tx.user.findUnique({ where: { email: ticket.senderEmail }, select: { id: true, locale: true, gdprAnonymizedAt: true } });
      if (recipient && !recipient.gdprAnonymizedAt) {
        const mail = await tx.outboxMessage.create({
          select: { id: true },
          data: {
            idempotencyKey: `support.replied:${input.ticketCode}`,
            templateKey: 'support.replied',
            locale: isLocale(recipient.locale) ? recipient.locale : routing.defaultLocale,
            toAddress: ticket.senderEmail,
            userId: recipient.id,
            organizationId: ticket.organizationId,
            // La respuesta a lo que escribe una entidad se lee en su panel (no sale en *Mi cuenta*); la de una familia, en su cuenta.
            payloadJson: { ticketCode: input.ticketCode, organization: 'KORUM', ...(ticket.fromOrganization && ticket.organization ? { panelOrgSlug: ticket.organization.slug } : {}) }
          }
        });
        outboxId = mail.id;
      }
    }
    return { status: 'OK', ticketCode: input.ticketCode, resolved: resolving, outboxId };
  });
}

export type RectificationOutcome = { status: 'CLOSED' } | { status: 'NOT_FOUND' | 'ALREADY_CLOSED' | 'INVALID' };

/**
 * Cierra la solicitud de rectificación (RGPD art. 16) que abrió una consulta, cuando ya se hizo el cambio (comprobando la identidad de la persona). Pide el Super-Admin
 * verificado: es un dato personal con plazo legal de un mes. Todo en una transacción con su auditoría: la solicitud no queda cerrada sin rastro (auditoría de seguridad del 5.3, M3).
 */
export async function closeRectificationRequest(db: KorumPrismaClient, actor: VerifiedSuperadminActor, payload: unknown, now: Date = new Date()): Promise<RectificationOutcome> {
  assertVerifiedSuperadmin(actor, 'privacy.request_close', now);
  const parsed = rectificationCloseSchema.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID' };
  const { ticketCode, outcome, notes } = parsed.data;
  return inTransaction(db, async (tx): Promise<RectificationOutcome> => {
    await revalidateActor(tx, actor, 'privacy.request_close', now);
    const request = await tx.privacyRequest.findFirst({ where: { type: 'RECTIFICATION', status: { in: ['RECEIVED', 'IN_PROGRESS'] }, ...noteWhere(ticketCode) }, select: { id: true } });
    if (!request) {
      const closed = await tx.privacyRequest.count({ where: { type: 'RECTIFICATION', ...noteWhere(ticketCode) } });
      return { status: closed > 0 ? 'ALREADY_CLOSED' : 'NOT_FOUND' };
    }
    try {
      await closePrivacyRequest(tx, request.id, { status: outcome, notes: notes ? `${requestNoteOf(ticketCode)}: ${notes}` : requestNoteOf(ticketCode) }, { kind: 'superadmin', actor }, now);
      return { status: 'CLOSED' };
    } catch (error) {
      if (error instanceof PrivacyRequestError) return { status: error.code === 'ALREADY_CLOSED' ? 'ALREADY_CLOSED' : 'NOT_FOUND' };
      throw error;
    }
  });
}

export type RectifyNameOutcome = { status: 'DONE' } | { status: 'INVALID' | 'NOT_FOUND' | 'NO_ACCOUNT' };

/**
 * Corrige el **nombre** de la cuenta de quien pidió la rectificación (RGPD art. 16): la única rectificación que se hace desde la consola. Exige el Super-Admin verificado, una
 * solicitud de rectificación **abierta** de esa consulta (no se puede renombrar una cuenta sin solicitud) y una cuenta viva (no anonimizada). Queda en la auditoría con la longitud
 * del nombre nuevo, nunca el nombre. **El cambio de email no se ofrece**: exige comprobar que la persona controla el nuevo y mover las consultas atadas al email antiguo; hasta que
 * exista ese trámite verificado se hace por el canal de privacidad (CUMPLIMIENTO §9, bloquea el paso a cobros reales).
 */
export async function rectifyAccountName(db: KorumPrismaClient, actor: VerifiedSuperadminActor, payload: unknown, now: Date = new Date(), meta?: RequestMeta): Promise<RectifyNameOutcome> {
  assertVerifiedSuperadmin(actor, 'privacy.rectify_name', now);
  const parsed = rectifyNameSchema.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID' };
  const { ticketCode, name } = parsed.data;
  return inTransaction(db, async (tx): Promise<RectifyNameOutcome> => {
    await revalidateActor(tx, actor, 'privacy.rectify_name', now);
    const [ticket, request] = await Promise.all([
      tx.supportTicket.findFirst({ where: { ticketCode, target: 'SUPERADMIN', topic: 'RECTIFICATION', fromOrganization: false }, select: { senderEmail: true } }),
      tx.privacyRequest.findFirst({ where: { type: 'RECTIFICATION', status: { in: ['RECEIVED', 'IN_PROGRESS'] }, ...noteWhere(ticketCode) }, select: { id: true, userId: true } })
    ]);
    if (!ticket || !request) return { status: 'NOT_FOUND' };
    const user = ticket.senderEmail ? await tx.user.findUnique({ where: { email: ticket.senderEmail }, select: { id: true, gdprAnonymizedAt: true } }) : null;
    if (!user || user.gdprAnonymizedAt) return { status: 'NO_ACCOUNT' };
    // La cuenta tiene que ser la de quien abrió la solicitud: si el email de la consulta ya no es suyo (cambiado fuera de la aplicación), no se renombra la de otra persona.
    if (request.userId !== user.id) return { status: 'NOT_FOUND' };
    await tx.user.update({ where: { id: user.id }, data: { name } });
    await writeAudit(tx, { ...auditWho(actor, meta), action: 'privacy.account_name_rectified', targetType: 'User', targetId: user.id, metadata: { ticketCode, requestId: request.id, characters: name.length } });
    return { status: 'DONE' };
  });
}

/** Un email directo se puede enviar (y reintentar) durante 7 días desde que se escribe; pasado ese plazo la bandeja lo cancela. */
const DIRECT_EMAIL_VALID_MS = 7 * 86_400_000;

export type DirectEmailOutcome = { status: 'SENT'; recipients: number; outboxIds: number[] } | { status: 'REJECTED'; reason: 'INVALID_INPUT' | 'NOT_FOUND' | 'RATE_LIMITED' | 'NO_RECIPIENTS' };

/**
 * «✉️ Enviar email directo al centro» (prototipo, aplazado del 5.2): un texto libre de KORUM a quienes firman por la entidad, cada persona en su idioma. Sale con el nombre de la
 * plataforma, así que: exige el Super-Admin **verificado** (TOTP reciente), **no admite enlaces ni direcciones** (el camino más corto a un phishing), lleva dos topes (3 por entidad
 * y día, y 20 por persona y día), el remitente es KORUM y no la propia entidad, el texto **no se conserva** en la bandeja de salida una vez enviado, y la auditoría guarda la
 * longitud, a cuántas personas salió y desde dónde (HMAC de la IP y navegador), nunca el contenido. Un intento que no sale devuelve el cupo. Una entidad archivada no recibe nada.
 */
export async function sendDirectEmailToOrganization(db: KorumPrismaClient, actor: VerifiedSuperadminActor, hmacSecret: string, organizationId: string, payload: unknown, now: Date = new Date(), meta?: RequestMeta): Promise<DirectEmailOutcome> {
  assertVerifiedSuperadmin(actor, 'support.direct_email', now);
  const parsed = directEmailSchema.safeParse(payload);
  if (!parsed.success) return { status: 'REJECTED', reason: 'INVALID_INPUT' };
  const { subject, message } = parsed.data;
  const orgKey = `${CONSOLE_DIRECT_EMAIL_RULE.prefix}${dataHmac(hmacSecret, 'console-direct-email', organizationId)}`;
  const personKey = `${CONSOLE_DIRECT_EMAIL_PERSON_RULE.prefix}${actor.userId}`;
  if (!(await reserveAttempt(db, orgKey, CONSOLE_DIRECT_EMAIL_RULE, now))) return { status: 'REJECTED', reason: 'RATE_LIMITED' };
  if (!(await reserveAttempt(db, personKey, CONSOLE_DIRECT_EMAIL_PERSON_RULE, now))) {
    await releaseAttempt(db, orgKey);
    return { status: 'REJECTED', reason: 'RATE_LIMITED' };
  }
  const outcome = await inTransaction(db, async (tx): Promise<DirectEmailOutcome> => {
    await revalidateActor(tx, actor, 'support.direct_email', now);
    const organization = await tx.organization.findFirst({ where: { id: organizationId, archivedAt: null }, select: { name: true } });
    if (!organization) return { status: 'REJECTED', reason: 'NOT_FOUND' };
    // La clave de idempotencia lleva la entidad: dos envíos a entidades distintas en el mismo milisegundo no se pisan aunque compartan una persona firmante.
    const batch = `direct:${organizationId}:${now.getTime()}`;
    const recipients = await notifySigners(tx, organizationId, 'platform.message', batch, { organization: organization.name, subject, message, expiresAt: new Date(now.getTime() + DIRECT_EMAIL_VALID_MS).toISOString() });
    if (recipients === 0) return { status: 'REJECTED', reason: 'NO_RECIPIENTS' };
    await writeAudit(tx, { ...auditWho(actor, meta), organizationId, action: 'support.direct_email_sent', targetType: 'Organization', targetId: organizationId, metadata: { recipients, subjectLength: subject.length, messageLength: message.length } });
    const outbox = await tx.outboxMessage.findMany({ where: { templateKey: 'platform.message', organizationId, idempotencyKey: { startsWith: `platform.message:${batch}:` } }, select: { id: true } });
    return { status: 'SENT', recipients, outboxIds: outbox.map((row) => row.id) };
  });
  // Un intento que no llegó a salir no gasta ningún cupo.
  if (outcome.status === 'REJECTED') {
    await releaseAttempt(db, orgKey);
    await releaseAttempt(db, personKey);
  }
  return outcome;
}
