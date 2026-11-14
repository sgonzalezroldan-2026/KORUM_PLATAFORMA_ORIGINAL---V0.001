import { z } from 'zod';
import { signResizeVoteToken } from '@/core/resize/resize-rules';
import { dataHmac } from '@/core/security/data-hmac';
import { hashIpSubnet } from '@/core/security/device-signals';
import { InvalidEmailError, normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { RESIZE_LINK_EMAIL_RULE, RESIZE_LINK_IP_RULE } from '@/lib/rate-limit-rules';
import { DONOR_RECIPIENT_SELECT, donorCandidatesWhere, donorRecipient } from '@/services/notifications/donor-recipient';

/**
 * «Reenviarme mi enlace de voto» (Sprint 5.5b, heredado del 4.4b). Quien donó a una campaña en votación y perdió el email puede pedir su enlace personal otra vez
 * desde `/{entidad}/votacion`, sin cuenta, escribiendo su email.
 *
 * - **La respuesta es siempre la misma y tarda lo mismo**, haya donado o no: la petición solo valida el email y reserva los topes (`reserveResendAttempt`); la
 *   búsqueda de donaciones, la bandeja de salida y la auditoría van después de responder (`queueResendLinks`, desde `after()`). Así ni el texto ni el tiempo de
 *   respuesta dicen quién ha aportado a qué (RGPD; auditoría de seguridad del 5.5b, H1).
 * - **El enlace va al email guardado en la donación, nunca al escrito**: se compara por email canónico, así que escribir una variante (`ana+x@gmail.com`) no
 *   desvía el enlace de otra persona a un buzón ajeno.
 * - Topes por red y por email (canónico, en HMAC): no sirve para llenar el buzón de nadie ni la bandeja de salida.
 * - Sale con la misma plantilla de la votación (`initiative.resizePoll`), en el idioma en que donó; el enlace es secreto de la bandeja y vale hasta el cierre.
 */

export type ResendAttempt = { status: 'ACCEPTED'; request: ResendRequest } | { status: 'INVALID_EMAIL' } | { status: 'RATE_LIMITED' };
export interface ResendRequest {
  orgSlug: string;
  canonical: string;
  emailKey: string;
}

const inputSchema = z.object({ orgSlug: z.string().min(1).max(80), email: z.string().trim().min(3).max(254) }).strict();
const RESEND_BUCKET_MS = 15 * 60_000;

/** Fase en la petición: valida y reserva los topes. No lee nada de las donaciones. */
export async function reserveResendAttempt(db: KorumPrismaClient, secret: string, payload: unknown, context: { ip: string | null }, now: Date = new Date()): Promise<ResendAttempt> {
  const parsed = inputSchema.safeParse(payload);
  if (!parsed.success) return { status: 'INVALID_EMAIL' };
  let canonical: string;
  try {
    canonical = normalizeCanonicalEmail(parsed.data.email);
  } catch (error) {
    if (error instanceof InvalidEmailError) return { status: 'INVALID_EMAIL' };
    throw error;
  }
  const emailKey = dataHmac(secret, 'resize-link-resend', canonical);
  if (!(await reserveAttempt(db, `${RESIZE_LINK_IP_RULE.prefix}${hashIpSubnet(secret, context.ip)}`, RESIZE_LINK_IP_RULE, now))) return { status: 'RATE_LIMITED' };
  if (!(await reserveAttempt(db, `${RESIZE_LINK_EMAIL_RULE.prefix}${emailKey}`, RESIZE_LINK_EMAIL_RULE, now))) return { status: 'RATE_LIMITED' };
  return { status: 'ACCEPTED', request: { orgSlug: parsed.data.orgSlug, canonical, emailKey } };
}

/** Fase diferida (después de responder): deja en la bandeja de salida el enlace de cada votación abierta de esa entidad en la que esa persona donó. */
export async function queueResendLinks(db: KorumPrismaClient, secret: string, request: ResendRequest, now: Date = new Date()): Promise<number[]> {
  const { canonical, emailKey } = request;
  const polls = await db.resizePoll.findMany({
    where: { status: 'OPEN', talliedAt: null, closesAt: { gt: now }, initiative: { status: 'RESIZE_VOTING', organization: { slug: request.orgSlug, archivedAt: null } } },
    select: { id: true, closesAt: true, initiativeId: true, initiative: { select: { organizationId: true, walletEscrowId: true } } }
  });
  const outboxIds: number[] = [];
  for (const poll of polls) {
    const rows = await db.contribution.findMany({
      where: { initiativeId: poll.initiativeId, type: 'DONATION', status: 'COMPLETED', ...donorCandidatesWhere(canonical) },
      orderBy: { id: 'asc' },
      select: { id: true, locale: true, ...DONOR_RECIPIENT_SELECT }
    });
    const donation = rows.find((row) => donorRecipient(row)?.canonical === canonical);
    const recipient = donation ? donorRecipient(donation) : null;
    if (!donation || !recipient) continue;
    const closesAt = poll.closesAt.toISOString();
    // Una por persona, votación y cuarto de hora: pulsar dos veces seguidas no manda dos emails.
    const idempotencyKey = `initiative.resizePoll:resend:${poll.id}:${emailKey}:${Math.floor(now.getTime() / RESEND_BUCKET_MS)}`;
    const message = await db.outboxMessage.upsert({
      where: { idempotencyKey },
      create: {
        idempotencyKey,
        templateKey: 'initiative.resizePoll',
        locale: donation.locale,
        toAddress: recipient.toAddress,
        organizationId: poll.initiative.organizationId,
        payloadJson: { initiativeId: poll.initiativeId, walletEscrowId: poll.initiative.walletEscrowId, pollId: poll.id, closesAt, expiresAt: closesAt, voteToken: signResizeVoteToken(secret, poll.id, donation.id) }
      },
      update: {},
      select: { id: true, status: true }
    });
    if (message.status === 'PENDING') outboxIds.push(message.id);
    // Sin email ni donación: qué votación pidió un reenvío, para ver un abuso en la auditoría (que no se purga; los topes la acotan).
    await db.auditLog.create({ data: { actorType: 'SYSTEM', organizationId: poll.initiative.organizationId, action: 'resize.link_resent', targetType: 'ResizePoll', targetId: String(poll.id), metadataJson: {} } });
  }
  return outboxIds;
}
