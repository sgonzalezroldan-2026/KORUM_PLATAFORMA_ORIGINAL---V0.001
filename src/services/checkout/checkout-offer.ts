import { canIssueTaxCertificate, guaranteeChoices } from '@/core/checkout/checkout-rules';
import { PROVINCES } from '@/core/onboarding/provinces';
import { groupSlug, orderedGroupClusters } from '@/core/public/course-challenge';
import type { InitiativeDetailData } from '@/core/public/view-model';
import type { CheckoutOffer } from '@/components/checkout/checkout-draft';
import type { CheckoutContext } from '@/repositories/checkout.repository';

/**
 * Lo que el checkout enseña a la familia, construido en el servidor con los datos públicos de la ficha y las condiciones de la entidad. Solo
 * datos públicos y derivados: nunca correos de otras personas ni importes internos de la pizarra.
 */
export function buildCheckoutOffer(input: {
  orgSlug: string;
  title: string;
  contentLang: string | undefined;
  detail: InitiativeDetailData;
  context: CheckoutContext;
  requestedGroup: string;
  sessionEmail: string | null;
  now: Date;
}): CheckoutOffer {
  const { detail, context } = input;
  const { card } = detail;
  const ticketing = context.format === 'TICKETING';
  const organization = context.organization;
  const closedReason = card.achieved ? (ticketing ? 'soldOut' : 'achieved') : card.closed || context.closesAt <= input.now ? 'ended' : ticketing && card.ticketsAvailable === 0 ? 'soldOut' : null;
  const clusters = context.rewardEnabled ? orderedGroupClusters(organization.vertical, organization.participationGroupsJson) : [];
  const allGroups = clusters.flatMap((cluster) => cluster.items);
  // `?grupo=` del enlace compartido preselecciona el curso: se compara con los grupos de la entidad, nunca se usa el texto tal cual.
  const preselected = input.requestedGroup ? (allGroups.find((groupName) => groupSlug(groupName) === input.requestedGroup) ?? null) : null;
  const certificate = !ticketing && canIssueTaxCertificate(organization);

  return {
    orgSlug: input.orgSlug,
    initiativeId: context.id,
    title: input.title,
    legalName: organization.legalName,
    vertical: organization.vertical,
    contentLang: input.contentLang,
    kind: ticketing ? 'TICKET' : 'DONATION',
    closedReason,
    donation: ticketing ? null : { presetsCents: organization.donationPresetsCents, defaultIdx: organization.defaultDonationIdx },
    ticket:
      ticketing && detail.ticket
        ? {
            subtype: context.ticketSubtype === 'RAFFLE' ? 'RAFFLE' : 'EVENT',
            available: card.ticketsAvailable,
            max: card.ticketMax,
            venue: detail.ticket.venue,
            pricing: { mode: detail.ticket.mode, priceCents: detail.ticket.priceCents, feeUnitCents: detail.ticket.feeUnitCents, buyerUnitCents: detail.ticket.buyerUnitCents }
          }
        : null,
    groups: clusters.map((cluster) => ({ group: cluster.group, items: cluster.items })),
    initialGroup: preselected,
    plaque: context.plaqueEnabled,
    guarantee: { suggestedCents: organization.fullIntegrityCheckCents, choicesCents: guaranteeChoices(context.guaranteePresetsCents, organization.fullIntegrityCheckCents) },
    certificate,
    provinces: certificate ? PROVINCES.map((province) => ({ code: province.code, name: province.name })) : [],
    sessionEmail: input.sessionEmail
  };
}

