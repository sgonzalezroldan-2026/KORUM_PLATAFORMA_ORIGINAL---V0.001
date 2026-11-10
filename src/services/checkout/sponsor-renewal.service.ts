import { z } from 'zod';
import { CHECKOUT_METHODS } from '@/core/checkout/checkout-limits';
import { signCheckoutResult, spanishFiscalYear } from '@/core/checkout/checkout-rules';
import { hashIpSubnet } from '@/core/security/device-signals';
import { renewalExpiry, renewalWindowOpen, type SponsorRenewalRule } from '@/core/sponsors/sponsor-reassignment-rules';
import { newRenewalOrder, readRenewalToken } from '@/core/sponsors/sponsor-renewal-token';
import { calculateSponsorCharge } from '@/core/sponsors/sponsorship-rules';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { CHECKOUT_RULE } from '@/lib/rate-limit-rules';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { sponsorRenewalPath } from '@/lib/seo/portal-routes';
import type { CheckoutDeps, CheckoutRequestContext } from './checkout.service';
import { startHostedRedirect } from './hosted-checkout';

/**
 * Renovación anual de un comercio amigo (Sprint 4.2d). Sin tarjeta guardada: el comercio recibe un enlace firmado por email (preaviso de 30 días y el
 * día que vence) y paga en la página de Paycomet, con el mismo flujo que su primer patrocinio. Cada año es un patrocinio nuevo (fila y pedido `KR`
 * propios, con su factura); la entidad ya lo admitió, así que no vuelve a moderación. Su dinero entra en su bolsa y se coloca según la regla de la
 * entidad al confirmarse el cobro (`completeRenewalInTx`). El importe es el del año anterior; el fee, el de la entidad hoy.
 *
 * También renueva quien no marcó «renovar cada año» si la entidad le envió su invitación de ese año (Sprint 4.2f, `renewalInvitedAt`); su año nuevo
 * sigue sin renovación automática: el año siguiente necesitará otra invitación.
 */

/** Comercio que se puede renovar con este enlace: el mismo vencimiento que firmó el enlace, aún en plazo y sin renovación pagada. */
async function findRenewable(db: KorumPrismaClient, secret: string, slug: string, token: string, now: Date) {
  const parsed = readRenewalToken(secret, token);
  if (!parsed) return { status: 'INVALID' as const };
  const sponsor = await db.sponsor.findFirst({
    where: { id: parsed.sponsorId, organization: { slug, archivedAt: null } },
    select: {
      id: true,
      organizationId: true,
      initiativeId: true,
      name: true,
      cifEnc: true,
      cifKeyVersion: true,
      contactPerson: true,
      phone: true,
      email: true,
      logoFileId: true,
      sector: true,
      categoryLevel: true,
      tierRank: true,
      tierLabel: true,
      amountCents: true,
      promo: true,
      code: true,
      status: true,
      autoRenew: true,
      renewalInvitedAt: true,
      paidAt: true,
      expiresAt: true,
      contribution: { select: { locale: true } },
      renewals: { where: { paidAt: { not: null } }, select: { id: true }, take: 1 },
      organization: { select: { name: true, sponsorFeeBps: true, sponsorRenewalRule: true } }
    }
  });
  if (!sponsor || sponsor.paidAt === null) return { status: 'INVALID' as const };
  if (sponsor.renewals.length > 0) return { status: 'RENEWED' as const };
  if (sponsor.expiresAt.getTime() !== parsed.expiresAt.getTime() || (sponsor.status !== 'APPROVED' && sponsor.status !== 'CREDIT_POOL') || !(sponsor.autoRenew || sponsor.renewalInvitedAt !== null) || !renewalWindowOpen(sponsor.expiresAt, now)) {
    return { status: 'EXPIRED' as const };
  }
  return { status: 'OK' as const, sponsor };
}

export type RenewalOffer =
  | { status: 'INVALID' | 'EXPIRED' | 'RENEWED' }
  | {
      status: 'OK';
      organizationName: string;
      name: string;
      level: 'ORO' | 'PLATA' | 'BRONCE';
      amountCents: number;
      feeCents: number;
      vatCents: number;
      totalCents: number;
      newExpiresAt: string;
      rule: SponsorRenewalRule;
    };

/** Lo que la página enseña antes de pagar: nada del comercio salvo su nombre, su nivel y los importes. */
export async function loadRenewalOffer(db: KorumPrismaClient, secret: string, slug: string, token: string, now: Date = new Date()): Promise<RenewalOffer> {
  const found = await findRenewable(db, secret, slug, token, now);
  if (found.status !== 'OK') return { status: found.status };
  const { sponsor } = found;
  const charge = calculateSponsorCharge(sponsor.amountCents, sponsor.organization.sponsorFeeBps);
  return {
    status: 'OK',
    organizationName: sponsor.organization.name,
    name: sponsor.name,
    level: sponsor.categoryLevel,
    amountCents: charge.amountCents,
    feeCents: charge.feeCents,
    vatCents: charge.vatCents,
    totalCents: charge.totalChargedCents,
    newExpiresAt: renewalExpiry(sponsor.expiresAt, now).toISOString(),
    rule: sponsor.organization.sponsorRenewalRule
  };
}

export const renewalStartSchema = z.object({ orgSlug: z.string().min(1).max(80), token: z.string().min(10).max(120), method: z.enum(CHECKOUT_METHODS), locale: z.enum(['es', 'ca', 'en']) });

export type RenewalStart = { status: 'REDIRECT'; url: string } | { status: 'INVALID' | 'EXPIRED' | 'RENEWED' | 'RATE_LIMITED' | 'UNAVAILABLE' };

export async function startSponsorRenewal(deps: CheckoutDeps, raw: unknown, context: CheckoutRequestContext): Promise<RenewalStart> {
  const parsed = renewalStartSchema.safeParse(raw);
  if (!parsed.success) return { status: 'INVALID' };
  const input = parsed.data;
  const now = deps.now ?? new Date();
  if (!(await reserveAttempt(deps.db, `${CHECKOUT_RULE.prefix}${hashIpSubnet(deps.hmacSecret, context.ip)}`, CHECKOUT_RULE, now))) return { status: 'RATE_LIMITED' };
  const found = await findRenewable(deps.db, deps.hmacSecret, input.orgSlug, input.token, now);
  if (found.status !== 'OK') return { status: found.status };
  const { sponsor } = found;
  // El cobro necesita una campaña de referencia (la hucha a la que se asocia el pedido): la activa que cierra antes o, si no hay, la del año anterior.
  const anchor = (await deps.db.initiative.findFirst({ where: { organizationId: sponsor.organizationId, status: 'FUNDRAISING', format: 'BUDGET', closesAt: { gt: now } }, orderBy: [{ closesAt: 'asc' }, { id: 'asc' }], select: { id: true } }))?.id ?? sponsor.initiativeId;
  if (anchor === null) return { status: 'UNAVAILABLE' };

  const charge = calculateSponsorCharge(sponsor.amountCents, sponsor.organization.sponsorFeeBps);
  const order = newRenewalOrder();
  await inTransaction(deps.db, async (tx) => {
    // Un pedido de renovación sin pagar del mismo año se da por abandonado (si al final llega su cobro, renueva el año siguiente: Sprint 4.2f).
    await tx.contribution.updateMany({ where: { status: 'PENDING', type: 'SPONSORSHIP', sponsor: { renewedFromId: sponsor.id } }, data: { status: 'FAILED' } });
    const renewal = await tx.sponsor.create({
      data: {
        organizationId: sponsor.organizationId,
        initiativeId: anchor,
        renewedFromId: sponsor.id,
        name: sponsor.name,
        cifEnc: sponsor.cifEnc,
        cifKeyVersion: sponsor.cifKeyVersion,
        contactPerson: sponsor.contactPerson,
        phone: sponsor.phone,
        email: sponsor.email,
        logoFileId: sponsor.logoFileId,
        sector: sponsor.sector,
        categoryLevel: sponsor.categoryLevel,
        tierRank: sponsor.tierRank,
        tierLabel: sponsor.tierLabel,
        amountCents: charge.amountCents,
        feeGeneratedCents: charge.feeCents,
        // Una renovación no es una bolsa Matching 2x: su dinero se coloca con la regla de la entidad.
        isMatchingPool: false,
        promo: sponsor.promo,
        code: sponsor.code,
        // Quien renueva por invitación (sin «renovar cada año») sigue igual: el año que viene no recibe avisos sin otra invitación.
        autoRenew: sponsor.autoRenew,
        status: 'PENDING',
        expiresAt: renewalExpiry(sponsor.expiresAt, now)
      },
      select: { id: true }
    });
    await tx.contribution.create({
      data: {
        organizationId: sponsor.organizationId,
        initiativeId: anchor,
        sponsorId: renewal.id,
        guestEmail: sponsor.email,
        locale: input.locale,
        fiscalYear: spanishFiscalYear(now),
        type: 'SPONSORSHIP',
        amountCents: charge.amountCents,
        totalChargedCents: charge.totalChargedCents,
        paymentMethod: input.method,
        paycometOrder: order,
        status: 'PENDING',
        createdAt: now
      }
    });
  });
  // La vuelta de Paycomet lleva a la propia renovación, con la firma del pedido (no a una campaña: la renovación no va a una concreta).
  const returnUrl = `${absoluteUrl(input.locale, sponsorRenewalPath(input.orgSlug))}?${new URLSearchParams({ pedido: order, sig: signCheckoutResult(deps.hmacSecret, order) }).toString()}`;
  const url = await startHostedRedirect(deps.provider, deps.hmacSecret, { order, totalChargedCents: charge.totalChargedCents, method: input.method, orgSlug: input.orgSlug, initiativeId: anchor, locale: input.locale, ip: context.ip, returnUrl });
  if (url) return { status: 'REDIRECT', url };
  await deps.db.contribution.updateMany({ where: { paycometOrder: order, status: 'PENDING' }, data: { status: 'FAILED' } });
  return { status: 'UNAVAILABLE' };
}

/** Resultado de un pago de renovación, para quien vuelve de la página de pago con la firma de su pedido. */
export async function loadRenewalResult(db: KorumPrismaClient, slug: string, order: string) {
  return db.contribution.findFirst({
    where: { paycometOrder: order, type: 'SPONSORSHIP', sponsor: { renewedFromId: { not: null } }, organization: { slug, archivedAt: null } },
    select: { status: true, sponsor: { select: { name: true, categoryLevel: true, expiresAt: true, status: true } } }
  });
}
