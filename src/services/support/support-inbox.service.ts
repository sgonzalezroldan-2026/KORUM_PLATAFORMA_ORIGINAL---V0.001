import { dataHmac } from '@/core/security/crypto';
import { answerTicketSchema, entityMessageSchema, planTicketAnswer, type AnswerRejection } from '@/core/support/support-inbox-rules';
import { isLocale, routing, type Locale } from '@/i18n/routing';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { releaseAttempt, reserveAttempt } from '@/lib/rate-limit';
import { SUPPORT_ORG_TICKET_DAILY_RULE, SUPPORT_ORG_TICKET_RULE } from '@/lib/rate-limit-rules';
import { recordAudit, type SessionActor } from '@/repositories/tenant-guard';
import { writeAudit } from '@/services/audit/audit.service';
import { requireSigner } from '@/services/panel/kyb.service';
import { allocateTicketCode } from './ticket-code';

/**
 * Bandeja de soporte del centro (Sprint 4.4c, prototipo `id="sch-sub-support"` y `function submitSchoolTicketToSuperAdmin`). Las personas firmantes de
 * **su** entidad (con el segundo factor) contestan las consultas de las familias dirigidas al centro (`target = ORGANIZATION`) y escriben a KORUM por un
 * buzón propio. Nada de esto enseña ni acepta el email de la familia: quien contesta ve el código, el tema y el texto; el aviso «tienes una respuesta»
 * lo manda el servidor a la dirección que **él** lee de la consulta. La respuesta es una por consulta y el estado solo avanza (`support-inbox-rules`).
 *
 * Una consulta de una familia a KORUM (`PAYMENT`, `ACCOUNT`…) guarda también el `organizationId` del centro pero **no es del centro**: aquí no se lista
 * ni se puede contestar, y pedirla por su código responde igual que una inexistente. La consulta que escribe la propia entidad lleva `fromOrganization`.
 */

export type InboxOutcome = { status: 'OK'; ticketCode: string; outboxId: number | null; resolved: boolean } | { status: 'REJECTED'; reason: AnswerRejection };

export interface InboxDeps {
  db: KorumPrismaClient;
}

/** Contestar y/o cambiar el estado de una consulta de las familias de la entidad. */
export async function answerFamilyTicket(deps: InboxDeps, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<InboxOutcome> {
  const { db } = deps;
  const signer = await requireSigner(db, actor, organizationId, 'support.ticket_answer');
  const parsed = answerTicketSchema.safeParse(payload);
  if (!parsed.success) return { status: 'REJECTED', reason: 'INVALID_INPUT' };
  const input = parsed.data;

  return inTransaction(db, async (tx): Promise<InboxOutcome> => {
    // Solo una consulta de las familias a este centro: una de KORUM, de otra entidad o inexistente responde lo mismo (y deja rastro).
    const ticket = await tx.supportTicket.findFirst({
      where: { ticketCode: input.ticketCode, organizationId, target: 'ORGANIZATION', fromOrganization: false },
      select: { id: true, status: true, replyMessage: true, senderEmail: true, originLabel: true, message: true }
    });
    if (!ticket) {
      await recordAudit(tx, signer, { action: 'tenant.access_denied', organizationId, targetType: 'SupportTicket', targetId: '-', metadata: { reason: 'NOT_AN_ORGANIZATION_TICKET', attempted: 'support.ticket_answer' } });
      return { status: 'REJECTED', reason: 'NOT_FOUND' };
    }
    // Una consulta cuyo texto ya se borró (cuenta suprimida o plazo de conservación) no se contesta: nadie leería la respuesta.
    if (ticket.message === '') return { status: 'REJECTED', reason: 'PURGED' };
    const plan = planTicketAnswer({ status: ticket.status, hasReply: ticket.replyMessage !== null }, { reply: input.reply, status: input.status });
    if (!plan.ok) return { status: 'REJECTED', reason: plan.reason };

    // Escritura condicional: dos personas firmantes a la vez no se pisan (la segunda ve el estado nuevo y se rechaza).
    const resolving = plan.nextStatus === 'RESOLVED';
    const { count } = await tx.supportTicket.updateMany({
      where: { id: ticket.id, status: ticket.status, ...(plan.reply === null ? {} : { replyMessage: null }) },
      data: { status: plan.nextStatus, updatedAt: now, ...(plan.reply === null ? {} : { replyMessage: plan.reply, repliedAt: now }), ...(resolving ? { resolvedAt: now } : {}) }
    });
    if (count !== 1) return { status: 'REJECTED', reason: 'CONFLICT' };
    await writeAudit(tx, {
      actorType: 'USER',
      actorUserId: signer.userId,
      organizationId,
      action: 'support.ticket_answered',
      targetType: 'SupportTicket',
      targetId: String(ticket.id),
      // Nunca el texto de la respuesta ni el email: solo qué se hizo.
      metadata: { ticketCode: input.ticketCode, replied: plan.reply !== null, from: ticket.status, to: plan.nextStatus }
    });

    // El aviso a la familia sale solo si hay respuesta nueva y la consulta aún tiene dirección (se borra con la cuenta y con la purga de conservación).
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
            organizationId,
            payloadJson: { ticketCode: input.ticketCode, organization: ticket.originLabel }
          }
        });
        outboxId = mail.id;
      }
    }
    return { status: 'OK', ticketCode: input.ticketCode, outboxId, resolved: resolving };
  });
}

export type KorumMessageOutcome = { status: 'SENT'; ticketCode: string; outboxId: number } | { status: 'REJECTED'; reason: Extract<AnswerRejection, 'INVALID_INPUT'> | 'RATE_LIMITED' | 'CODE_EXHAUSTED' };

/** Buzón prioritario de la entidad hacia KORUM (`fromOrganization`, `target = SUPERADMIN`). El acuse sale en el idioma de la página desde la que escribe. */
export async function sendMessageToKorum(deps: InboxDeps & { hmacSecret: string }, actor: SessionActor, organizationId: string, input: { payload: unknown; locale: string }, now: Date = new Date()): Promise<KorumMessageOutcome> {
  const { db } = deps;
  const signer = await requireSigner(db, actor, organizationId, 'support.korum_message');
  const parsed = entityMessageSchema.safeParse(input.payload);
  if (!parsed.success) return { status: 'REJECTED', reason: 'INVALID_INPUT' };
  const message = parsed.data;
  const locale: Locale = isLocale(input.locale) ? input.locale : routing.defaultLocale;

  // Los topes van por entidad: una cuenta firmante robada no inunda la bandeja de KORUM, que lee estas consultas con prioridad.
  const key = dataHmac(deps.hmacSecret, 'support-org', organizationId);
  const hourly = `${SUPPORT_ORG_TICKET_RULE.prefix}${key}`;
  const daily = `${SUPPORT_ORG_TICKET_DAILY_RULE.prefix}${key}`;
  if (!(await reserveAttempt(db, hourly, SUPPORT_ORG_TICKET_RULE, now))) return { status: 'REJECTED', reason: 'RATE_LIMITED' };
  if (!(await reserveAttempt(db, daily, SUPPORT_ORG_TICKET_DAILY_RULE, now))) {
    await releaseAttempt(db, hourly);
    return { status: 'REJECTED', reason: 'RATE_LIMITED' };
  }

  const outcome = await inTransaction(db, async (tx): Promise<KorumMessageOutcome> => {
    const [organization, user] = await Promise.all([tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } }), tx.user.findUniqueOrThrow({ where: { id: signer.userId }, select: { email: true } })]);
    const ticketCode = await allocateTicketCode(tx);
    if (ticketCode === null) return { status: 'REJECTED', reason: 'CODE_EXHAUSTED' };
    const created = await tx.supportTicket.create({
      data: { ticketCode, organizationId, originLabel: organization.name, senderEmail: user.email, target: 'SUPERADMIN', fromOrganization: true, topic: message.topic, subject: message.subject, message: message.message, createdAt: now }
    });
    await writeAudit(tx, { actorType: 'USER', actorUserId: signer.userId, organizationId, action: 'support.korum_message_created', targetType: 'SupportTicket', targetId: String(created.id), metadata: { topic: message.topic } });
    const mail = await tx.outboxMessage.create({
      select: { id: true },
      data: { idempotencyKey: `support.received:${ticketCode}`, templateKey: 'support.received', locale, toAddress: user.email, userId: signer.userId, organizationId, payloadJson: { ticketCode, rectification: false, answeredBy: 'SUPERADMIN' } }
    });
    return { status: 'SENT', ticketCode, outboxId: mail.id };
  });
  if (outcome.status === 'REJECTED') {
    await releaseAttempt(db, hourly);
    await releaseAttempt(db, daily);
  }
  return outcome;
}
