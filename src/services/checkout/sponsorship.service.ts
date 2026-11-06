import { spanishFiscalYear } from '@/core/checkout/checkout-rules';
import { formatCents } from '@/core/finance/money';
import { hashIpSubnet } from '@/core/security/device-signals';
import { calculateSponsorCharge, newSponsorshipOrder, sponsorLevelOf, sponsorshipExpiry, sponsorshipInputSchema, sponsorshipInvalidField, type SponsorshipInvalidField } from '@/core/sponsors/sponsorship-rules';
import { sealSponsorTaxId } from '@/core/tax/tax-id-vault';
import { validateTaxId } from '@/core/tax/tax-id';
import { inTransaction } from '@/lib/db';
import { reserveAttempt } from '@/lib/rate-limit';
import { CHECKOUT_RULE } from '@/lib/rate-limit-rules';
import { getSponsorshipContext, isMatchingPoolTaken } from '@/repositories/sponsorship.repository';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';
import { loadLockedContribution } from '@/services/payments/payment-reversals';
import { startHostedRedirect } from './hosted-checkout';
import type { CheckoutDeps, CheckoutRequestContext } from './checkout.service';

/**
 * Inicio del pago de un comercio (Sprint 3.5, QA-F05). Mismo camino que el de las familias: se valida lo que envía el navegador, se crea el
 * patrocinio y su cobro `PENDING`, y se envía a la página de pago de Paycomet. El dinero solo se asienta cuando llega la notificación firmada
 * (`completeSponsorship`). El patrocinio nace `PENDING` y sin `paidAt`: el centro lo aprueba o rechaza tras el cobro (moderación, Sprint 4.2) y
 * hasta entonces no aparece en el directorio público.
 */

export type SponsorshipStart =
  | { status: 'REDIRECT'; url: string }
  | { status: 'INVALID'; field: SponsorshipInvalidField }
  | { status: 'CLOSED' }
  | { status: 'RATE_LIMITED' }
  | { status: 'UNAVAILABLE' };

/** Deja como fallido un patrocinio cuya página de pago no se pudo abrir. El comercio queda sin `paidAt`: la moderación solo ve los cobrados. */
async function abandonPendingSponsorship(deps: CheckoutDeps, order: string): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    const contribution = await loadLockedContribution(tx, { paycometOrder: order });
    if (contribution) await tx.contribution.updateMany({ where: { id: contribution.id, status: 'PENDING' }, data: { status: 'FAILED' } });
  });
}

export async function startSponsorship(deps: CheckoutDeps, raw: unknown, context: CheckoutRequestContext): Promise<SponsorshipStart> {
  const parsed = sponsorshipInputSchema.safeParse(raw);
  if (!parsed.success) return { status: 'INVALID', field: sponsorshipInvalidField(raw) };
  const input = parsed.data;
  const now = deps.now ?? new Date();
  const taxId = validateTaxId(input.taxId);
  if (!taxId.valid) return { status: 'INVALID', field: 'taxId' };

  // El límite es el mismo que el de las familias: cada inicio crea un patrocinio y un cobro pendientes.
  if (!(await reserveAttempt(deps.db, `${CHECKOUT_RULE.prefix}${hashIpSubnet(deps.hmacSecret, context.ip)}`, CHECKOUT_RULE, now))) return { status: 'RATE_LIMITED' };

  let sponsorship;
  try {
    sponsorship = await getSponsorshipContext(deps.db, input.orgSlug, input.initiativeId, now);
  } catch (error) {
    if (error instanceof ResourceNotFoundError) return { status: 'CLOSED' };
    throw error;
  }
  if (sponsorship.status !== 'FUNDRAISING' || sponsorship.closesAt <= now) return { status: 'CLOSED' };
  const { organization } = sponsorship;
  // El nivel lo elige el comercio entre los de la entidad: cualquier otro importe se rechaza, nunca se redondea.
  if (!organization.sponsorTiersCents.includes(input.tierCents)) return { status: 'INVALID', field: 'tier' };
  if (input.matchingPool && sponsorship.matchingPoolTaken) return { status: 'INVALID', field: 'matching' };

  const charge = calculateSponsorCharge(input.tierCents, organization.sponsorFeeBps);
  const { level, rank } = sponsorLevelOf(input.tierCents, organization.sponsorTiersCents);
  const order = newSponsorshipOrder();
  const email = input.email.toLowerCase();

  const taken = await inTransaction(deps.db, async (tx) => {
    if (input.matchingPool) {
      // Se bloquea la iniciativa y se vuelve a comprobar: dos comercios que piden la bolsa a la vez no pueden ocuparla los dos.
      const locked = await tx.initiative.update({ where: { id: sponsorship.id }, data: { updatedAt: new Date() }, select: { matchingPoolTotalCents: true } });
      if (await isMatchingPoolTaken(tx, sponsorship.id, locked.matchingPoolTotalCents, now)) return true;
    }
    const sponsor = await tx.sponsor.create({
      data: {
        organizationId: sponsorship.organizationId,
        initiativeId: sponsorship.id,
        name: input.businessName,
        ...sealSponsorTaxId(deps.keyring, sponsorship.organizationId, taxId.normalized),
        contactPerson: input.contactPerson,
        phone: input.phone,
        email,
        sector: input.sector,
        categoryLevel: level,
        tierRank: rank,
        tierLabel: `Patrocinio íntegro ${formatCents(charge.amountCents, 'es')} (+${formatCents(charge.feeCents, 'es')} fee)`,
        amountCents: charge.amountCents,
        feeGeneratedCents: charge.feeCents,
        isMatchingPool: input.matchingPool,
        promo: input.promo,
        code: input.promoCode.toUpperCase(),
        autoRenew: input.autoRenew,
        status: 'PENDING',
        expiresAt: sponsorshipExpiry(now)
      },
      select: { id: true }
    });
    await tx.contribution.create({
      data: {
        organizationId: sponsorship.organizationId,
        initiativeId: sponsorship.id,
        sponsorId: sponsor.id,
        guestEmail: email,
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
    return false;
  });
  if (taken) return { status: 'INVALID', field: 'matching' };

  const url = await startHostedRedirect(deps.provider, deps.hmacSecret, { order, totalChargedCents: charge.totalChargedCents, method: input.method, orgSlug: input.orgSlug, initiativeId: input.initiativeId, locale: input.locale, ip: context.ip });
  if (url) return { status: 'REDIRECT', url };
  await abandonPendingSponsorship(deps, order);
  return { status: 'UNAVAILABLE' };
}
