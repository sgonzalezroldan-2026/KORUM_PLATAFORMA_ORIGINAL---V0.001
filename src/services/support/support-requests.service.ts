import { dataHmac } from '@/core/security/crypto';
import { canonicalEmailOf, IdeaSignatureRejectedError } from '@/core/security/device-quorum.service';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import { supportTicketSchema, targetOfTopic } from '@/core/support/support-rules';
import { openPrivacyRequest } from '@/core/privacy/privacy-requests';
import type { VerifiedAccountActor } from '@/core/security/verified-actor';
import { isLocale, routing, type Locale } from '@/i18n/routing';
import { inTransaction, type Db } from '@/lib/db';
import { releaseAttempt, reserveAttempt } from '@/lib/rate-limit';
import { SUPPORT_TICKET_DAILY_RULE, SUPPORT_TICKET_RULE } from '@/lib/rate-limit-rules';
import { writeAudit } from '@/services/audit/audit.service';
import { allocateTicketCode } from './ticket-code';

/**
 * Consultas de soporte de las familias (Sprint 3.9, `fview-faq`). Quien escribe sale de la sesión y su email, de su cuenta con el email
 * verificado (nunca del formulario): así se evita que alguien abra consultas a nombre de otra persona, y la persona puede ver después las suyas
 * y exportarlas o borrarlas (las consultas se buscan por ese email, como ya hacen la exportación y la supresión). Una consulta sobre una iniciativa
 * o un evento va al centro; el resto, a KORUM. Pedir **corregir datos personales** (RGPD art. 16) abre además una `PrivacyRequest` de
 * rectificación con plazo de un mes: la persona tiene que haber confirmado su identidad hace menos de 10 minutos (`actor`).
 */

export type SupportRejection = 'INVALID_INPUT' | 'RATE_LIMITED' | 'ACCOUNT_NOT_ALLOWED' | 'ORGANIZATION_NOT_FOUND' | 'REAUTH_REQUIRED' | 'CODE_EXHAUSTED';
export type SupportOutcome = { status: 'SENT'; ticketCode: string; rectification: boolean; outboxId: number } | { status: 'REJECTED'; reason: SupportRejection };

export interface SupportDeps {
  db: Db;
  hmacSecret: string;
}

/**
 * @param actor Solo para `RECTIFICATION`: la persona reautenticada. Quien llama lo obtiene con `requireVerifiedAccount`; si no puede, pasa `null` y
 *   la consulta se rechaza con `REAUTH_REQUIRED` sin gastar el cupo.
 */
export async function submitSupportTicket(deps: SupportDeps, input: { userId: string; payload: unknown; actor: VerifiedAccountActor | null; locale: string }, now: Date = new Date()): Promise<SupportOutcome> {
  const parsed = supportTicketSchema.safeParse(input.payload);
  if (!parsed.success) return { status: 'REJECTED', reason: 'INVALID_INPUT' };
  const ticket = parsed.data;
  const rectification = ticket.topic === 'RECTIFICATION';
  if (rectification && (!input.actor || input.actor.userId !== input.userId)) return { status: 'REJECTED', reason: 'REAUTH_REQUIRED' };
  const { db } = deps;
  const locale: Locale = isLocale(input.locale) ? input.locale : routing.defaultLocale;

  // Los topes van por **persona** (email canónico), no por cuenta: `laura+1@` y `laura+2@` llegan al mismo buzón y no suman cupos.
  const account = await db.user.findUniqueOrThrow({ where: { id: input.userId }, select: { email: true, emailVerified: true, gdprAnonymizedAt: true } });
  let canonicalEmail: string;
  try {
    canonicalEmail = canonicalEmailOf(account);
  } catch (error) {
    if (error instanceof IdeaSignatureRejectedError) return { status: 'REJECTED', reason: 'ACCOUNT_NOT_ALLOWED' };
    throw error;
  }
  const sender = dataHmac(deps.hmacSecret, 'support-sender', canonicalEmail);
  // Por hora y por día. Si el segundo tope salta, se devuelve el intento del primero: no se castiga dos veces el mismo mensaje.
  const hourly = `${SUPPORT_TICKET_RULE.prefix}${sender}`;
  const daily = `${SUPPORT_TICKET_DAILY_RULE.prefix}${sender}`;
  if (!(await reserveAttempt(db, hourly, SUPPORT_TICKET_RULE, now))) return { status: 'REJECTED', reason: 'RATE_LIMITED' };
  if (!(await reserveAttempt(db, daily, SUPPORT_TICKET_DAILY_RULE, now))) {
    await releaseAttempt(db, hourly);
    return { status: 'REJECTED', reason: 'RATE_LIMITED' };
  }

  const outcome = await inTransaction(db, async (tx): Promise<SupportOutcome> => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { email: true } });
    const organization = await tx.organization.findFirst({ where: { slug: ticket.orgSlug, archivedAt: null }, select: { id: true, name: true } });
    if (!organization) return { status: 'REJECTED', reason: 'ORGANIZATION_NOT_FOUND' };

    const ticketCode = await allocateTicketCode(tx);
    if (ticketCode === null) return { status: 'REJECTED', reason: 'CODE_EXHAUSTED' };

    const target = targetOfTopic(ticket.topic);
    const created = await tx.supportTicket.create({
      data: { ticketCode, organizationId: organization.id, originLabel: organization.name, senderEmail: user.email, target, topic: ticket.topic, subject: ticket.subject, message: ticket.message, createdAt: now }
    });
    // Una solicitud de rectificación abierta ya corre su plazo: una consulta más no abre otra (no hay solicitudes duplicadas con plazo legal).
    if (rectification && input.actor && !(await tx.privacyRequest.findFirst({ where: { userId: input.userId, type: 'RECTIFICATION', status: { in: ['RECEIVED', 'IN_PROGRESS'] } }, select: { id: true } }))) {
      await openPrivacyRequest(tx, deps.hmacSecret, { actor: input.actor, type: 'RECTIFICATION', notes: `Soporte ${ticketCode}` }, now);
    }
    await writeAudit(tx, { actorType: 'USER', actorUserId: input.userId, organizationId: organization.id, action: 'support.ticket_created', targetType: 'SupportTicket', targetId: String(created.id), metadata: { topic: ticket.topic, target } });
    const mail = await tx.outboxMessage.create({
      select: { id: true },
      data: {
        idempotencyKey: `support.received:${ticketCode}`,
        templateKey: 'support.received',
        // En el idioma de la página desde la que escribe (`User.locale` vale `es` hasta que la persona lo cambia, aunque navegue en catalán).
        locale,
        toAddress: user.email,
        userId: input.userId,
        organizationId: organization.id,
        payloadJson: { ticketCode, rectification, answeredBy: target }
      }
    });
    return { status: 'SENT', ticketCode, rectification, outboxId: mail.id };
  }).catch((error: unknown): SupportOutcome => {
    // La confirmación de identidad pudo caducar entre la acción y la transacción: se pide de nuevo, no es un error del servidor.
    if (error instanceof SuperadminRequiredError) return { status: 'REJECTED', reason: 'REAUTH_REQUIRED' };
    throw error;
  });

  // Una consulta que no llegó a crearse devuelve el intento (no es spam); las que sí se crearon, no.
  if (outcome.status === 'REJECTED') {
    await releaseAttempt(db, hourly);
    await releaseAttempt(db, daily);
  }
  return outcome;
}

/** Las consultas de una persona (por el email verificado de su cuenta), las más recientes primero. Sin datos de otras personas. */
export async function listSupportTicketsOf(db: Db, user: { email: string; emailVerified: boolean; gdprAnonymizedAt: Date | null }, limit = 20) {
  if (!user.emailVerified || user.gdprAnonymizedAt) return [];
  return db.supportTicket.findMany({
    // Las que escribió en nombre de su entidad (`fromOrganization`) son de la entidad: se ven en su panel, no en la cuenta de quien las firmó.
    where: { senderEmail: user.email, fromOrganization: false },
    orderBy: { id: 'desc' },
    take: limit,
    select: { ticketCode: true, topic: true, target: true, subject: true, message: true, status: true, replyMessage: true, createdAt: true, originLabel: true, organization: { select: { slug: true } } }
  });
}
