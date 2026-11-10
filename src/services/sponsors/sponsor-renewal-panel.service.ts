import type { z } from 'zod';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { assignPooledSchema, renewalLinkSchema, renewalRuleSchema, renewalWindowOpen, SponsorReassignmentError } from '@/core/sponsors/sponsor-reassignment-rules';
import { inTransaction } from '@/lib/db';
import { reportError } from '@/lib/error-reporting';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { relocateSponsor } from './sponsor-reassignment.service';
import { renewalLinkPayload } from './sponsor-sweeps';

/**
 * Lo que la entidad decide sobre la renovación y la reasignación de sus comercios (Sprint 4.2d, `function saveSponsorRenewalRule` y
 * `function openSponsorDetailPopup` del prototipo). Como la moderación: solo `DIRECTOR` o `COSIGNER` de **esa** entidad, con el segundo factor en
 * esta sesión; el Super-Admin no decide por la entidad. Un comercio de otra entidad responde igual que uno inexistente y queda en la auditoría.
 */

type Action = 'sponsor.renewal_rule' | 'sponsor.assign_pool' | 'sponsor.renewal_link';

function parse<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new SponsorReassignmentError('INVALID_INPUT');
  return parsed.data;
}

async function authorize(db: KorumPrismaClient, actor: SessionActor, organizationId: string, action: Action, sponsorId?: number): Promise<string> {
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, targetType: sponsorId ? 'Sponsor' : 'Organization', targetId: sponsorId ? String(sponsorId) : organizationId, metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: action } });
    throw new TenantAccessError(actor.kind === 'user' ? 'ROLE_NOT_ALLOWED' : 'ANONYMOUS');
  }
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action, targetType: sponsorId ? 'Sponsor' : 'Organization', ...(sponsorId ? { targetId: sponsorId } : {}), allowSuperadmin: false });
  if (sponsorId !== undefined) {
    const owner = await db.sponsor.findUnique({ where: { id: sponsorId }, select: { organizationId: true } });
    await requireOwnedResource(db, actor, { organizationId, resourceType: 'Sponsor', resourceId: sponsorId, resourceLabel: 'Comercio', ownerOrganizationId: owner?.organizationId ?? null });
  }
  return (actor as Extract<SessionActor, { kind: 'user' }>).userId;
}

/**
 * Guarda la regla de la entidad. Con `SOONEST` o `PROPORTIONAL`, lo que ya esperaba en la bolsa se coloca al momento si hay campaña (cada comercio en su
 * transacción); con `MANUAL`, sigue esperando a que el centro elija.
 */
export async function saveSponsorRenewalRule(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<{ placed: number }> {
  const { rule } = parse(renewalRuleSchema, payload);
  const userId = await authorize(db, actor, organizationId, 'sponsor.renewal_rule');
  const before = await inTransaction(db, async (tx) => {
    const current = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { sponsorRenewalRule: true } });
    await tx.organization.update({ where: { id: organizationId }, data: { sponsorRenewalRule: rule } });
    await recordAudit(tx, actor, { action: 'sponsor.renewal_rule_saved', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { before: current.sponsorRenewalRule, after: rule, by: userId } }, { required: true });
    return current.sponsorRenewalRule;
  });
  let placed = 0;
  if (rule !== 'MANUAL' && before !== rule) {
    const pooled = await db.sponsor.findMany({ where: { organizationId, status: 'CREDIT_POOL' }, orderBy: { id: 'asc' }, take: 50, select: { id: true } });
    for (const { id } of pooled) {
      try {
        const outcome = await inTransaction(db, (tx) => relocateSponsor(tx, id, now));
        if (outcome.kind === 'PLACED') placed += 1;
      } catch (error) {
        reportError(error, { stage: 'sponsor-rule-relocate', sponsorId: id });
      }
    }
  }
  return { placed };
}

/** Lleva a una campaña elegida por el centro todo lo que el comercio tiene en la bolsa. La campaña debe estar recaudando y dentro de la ventana del cobro. */
export async function assignPooledSponsor(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, now: Date = new Date()): Promise<{ title: string }> {
  const { sponsorId, initiativeId } = parse(assignPooledSchema, payload);
  const userId = await authorize(db, actor, organizationId, 'sponsor.assign_pool', sponsorId);
  const target = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Initiative', resourceId: initiativeId, resourceLabel: 'Iniciativa', ownerOrganizationId: target?.organizationId ?? null });
  return inTransaction(db, async (tx) => {
    const sponsor = await tx.sponsor.findUniqueOrThrow({ where: { id: sponsorId }, select: { status: true } });
    if (sponsor.status !== 'CREDIT_POOL') throw new SponsorReassignmentError('POOL_CHANGED');
    const outcome = await relocateSponsor(tx, sponsorId, now, { manualTarget: initiativeId });
    if (outcome.kind !== 'PLACED') {
      const after = await tx.sponsor.findUniqueOrThrow({ where: { id: sponsorId }, select: { status: true } });
      throw new SponsorReassignmentError(after.status === 'CREDIT_POOL' ? 'TARGET_NOT_ELIGIBLE' : 'POOL_CHANGED');
    }
    await recordAudit(tx, actor, { action: 'sponsor.pool_assigned', organizationId, targetType: 'Sponsor', targetId: String(sponsorId), metadata: { initiativeId, amountCents: outcome.amountCents, by: userId } }, { required: true });
    return { title: outcome.titles[0] ?? '' };
  });
}

/**
 * Envía (otra vez) al comercio el enlace de pago de su renovación, desde 30 días antes de que venza su distintivo hasta 30 días después. Una vez al día
 * como mucho: la clave lleva la fecha. Devuelve el mensaje, para enviarlo al momento.
 *
 * A un comercio que no marcó «renovar cada año» se le puede enviar **una invitación por año de distintivo** (decisión del promotor del 2026-11-10,
 * Sprint 4.2f): queda anotada (`renewalInvitedAt`), su texto la presenta como invitación y abre el mismo enlace de pago. No se repite.
 */
export async function sendRenewalLink(db: KorumPrismaClient, actor: SessionActor, organizationId: string, payload: unknown, secret: string, now: Date = new Date()): Promise<{ messageId: number | null }> {
  const { sponsorId } = parse(renewalLinkSchema, payload);
  const userId = await authorize(db, actor, organizationId, 'sponsor.renewal_link', sponsorId);
  const sponsor = await db.sponsor.findUniqueOrThrow({
    where: { id: sponsorId },
    select: { id: true, status: true, autoRenew: true, renewalInvitedAt: true, paidAt: true, email: true, amountCents: true, expiresAt: true, organization: { select: { contentLocale: true } }, contribution: { select: { locale: true } }, renewals: { where: { paidAt: { not: null } }, select: { id: true }, take: 1 } }
  });
  if ((sponsor.status !== 'APPROVED' && sponsor.status !== 'CREDIT_POOL') || sponsor.paidAt === null || sponsor.renewals.length > 0 || !renewalWindowOpen(sponsor.expiresAt, now)) {
    throw new SponsorReassignmentError('RENEWAL_NOT_OPEN');
  }
  const invitation = !sponsor.autoRenew;
  if (invitation && sponsor.renewalInvitedAt !== null) throw new SponsorReassignmentError('ALREADY_INVITED');
  // Antes de que caduque, el texto es el del preaviso («caduca el…»); después, el de «ha caducado». Mismo enlace firmado. La invitación tiene el suyo.
  const idempotencyKey = invitation ? `sponsor.renewalInvite:${sponsor.id}` : `sponsor.renewalLink:${sponsor.id}:manual:${now.toISOString().slice(0, 10)}`;
  const templateKey = invitation ? 'sponsor.renewalInvite' : sponsor.expiresAt > now ? 'sponsor.renewalNotice' : 'sponsor.renewalLink';
  await inTransaction(db, async (tx) => {
    // Dos personas a la vez: solo la primera anota la invitación (la segunda no envía otra).
    if (invitation && (await tx.sponsor.updateMany({ where: { id: sponsor.id, renewalInvitedAt: null, autoRenew: false }, data: { renewalInvitedAt: now } })).count !== 1) throw new SponsorReassignmentError('ALREADY_INVITED');
    await tx.outboxMessage.createMany({
      data: [{ idempotencyKey, templateKey, locale: sponsor.contribution?.locale ?? sponsor.organization.contentLocale, toAddress: sponsor.email, organizationId, payloadJson: renewalLinkPayload(secret, sponsor) }],
      skipDuplicates: true
    });
    await recordAudit(tx, actor, { action: invitation ? 'sponsor.renewal_invited' : 'sponsor.renewal_link_sent', organizationId, targetType: 'Sponsor', targetId: String(sponsorId), metadata: { by: userId } }, { required: true });
  });
  const message = await db.outboxMessage.findUnique({ where: { idempotencyKey }, select: { id: true, status: true } });
  return { messageId: message?.status === 'PENDING' ? message.id : null };
}
