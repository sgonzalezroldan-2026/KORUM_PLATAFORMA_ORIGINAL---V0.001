import { projectGuaranteeContributionsAt100, type GuaranteeSample } from '@/core/finance/bi-analytics.service';
import { BI_OPEN_STATUSES, type BiInitiativeFacts, type BiOrganizationFacts } from '@/core/finance/bi-aggregate';
import { getBalancesByOrganization } from '@/core/finance/ledger-balances';
import { calculateStudioTicketingTCO } from '@/core/finance/tco.service';
import type { LedgerAccount } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import type { KorumGlobalRulesCents } from '@/types/korum.types';

/**
 * Lectura de los datos del BI (Sprint 5.1): iniciativas, entidades y lo cobrado según el libro mayor. Solo lectura y sin decidir nada:
 * las cifras que se muestran salen de `src/core/finance/bi-aggregate.ts`. Quien llama ya pasó `authorizeSuperadmin`.
 */

/** Tope de iniciativas que lee una vista: si hay más, la consola lo dice en vez de cortar en silencio. */
export const BI_MAX_INITIATIVES = 1000;

/** Cuentas del libro que alimentan los ingresos reales (6 fuentes y costes). */
export const REAL_REVENUE_ACCOUNTS: readonly LedgerAccount[] = [
  'KORUM_REVENUE_BRACKET',
  'KORUM_REVENUE_GUARANTEE',
  'KORUM_REVENUE_SPONSOR_FEE',
  'KORUM_REVENUE_TICKET_FEE',
  'KORUM_REVENUE_MAINTENANCE',
  'KORUM_REVENUE_TOPUP_FEE',
  'GATEWAY_FEES_EXPENSE',
  'GATEWAY_FEES_RECOVERED',
  'AUTO_BOOST_EXPENSE',
  'CHARGEBACK_LOSSES'
];

export async function loadGlobalRules(db: Db): Promise<KorumGlobalRulesCents> {
  const config = await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' } });
  return {
    exemptLimitCents: config.exemptLimitCents,
    bracketMode: config.bracketMode,
    t1MaxCents: config.t1MaxCents,
    t2MaxCents: config.t2MaxCents,
    t1Bps: config.t1Bps,
    t2Bps: config.t2Bps,
    t3Bps: config.t3Bps,
    sponsorFeeBps: config.sponsorFeeBps,
    fullIntegrityCheckCents: config.fullIntegrityCheckCents,
    guaranteePresetsCents: config.guaranteePresetsCents,
    defaultGuaranteeIdx: config.defaultGuaranteeIdx,
    gatewayPctBps: config.gatewayPctBps,
    gatewayFixedCents: config.gatewayFixedCents,
    topupFeeCents: config.topupFeeCents,
    topupFeeBps: config.topupFeeBps,
    ticketFeeFixedCents: config.ticketFeeFixedCents,
    ticketFeeBps: config.ticketFeeBps,
    maintActive: config.maintActive,
    maintPerInitCents: config.maintPerInitCents,
    maintAnnualCapCents: config.maintAnnualCapCents
  };
}

interface LedgerPerInitiative {
  guarantee: number;
  ticketFee: number;
  sponsorFee: number;
  topupFee: number;
  bracketFee: number;
  maintFee: number;
  /** Pasarela pagada a Paycomet (gasto) y la recuperada al liquidar (ingreso). */
  gatewayExpense: number;
  gatewayRecovered: number;
  autoBoost: number;
  chargebacks: number;
  /** Pasarela de los cobros de entradas y de las aportaciones mensuales de Mi Hucha (para su margen). */
  gatewayTicket: number;
  gatewayHucha: number;
}

const emptyLedger = (): LedgerPerInitiative => ({
  guarantee: 0, ticketFee: 0, sponsorFee: 0, topupFee: 0, bracketFee: 0, maintFee: 0, gatewayExpense: 0, gatewayRecovered: 0, autoBoost: 0, chargebacks: 0, gatewayTicket: 0, gatewayHucha: 0
});

const INITIATIVE_SELECT = {
  id: true, walletEscrowId: true, title: true, organizationId: true, status: true, format: true, quarter: true, closesAt: true, goalCents: true, raisedCents: true, totalContributions: true,
  bracketFeeCents: true, maintFeeCents: true, gatewayFeeCents: true, absorbsGatewayCostByKorum: true, ticketPriceCents: true, ticketMax: true, ticketsSold: true, ticketFeeMode: true
} as const;

/**
 * Lo cobrado por cada iniciativa según los apuntes del libro: ingreso de cada fuente (neto de devoluciones), los costes asumidos (pasarela
 * neta, Auto-Impulso y contracargos) y la pasarela de los cobros de entradas y de Mi Hucha. Los apuntes de ingreso solo llevan la entidad: la
 * iniciativa sale de su asiento. Una sola consulta: todo sale de la misma lectura.
 */
async function loadLedgerPerInitiative(db: Db): Promise<Map<number, LedgerPerInitiative>> {
  const entries = await db.escrowLedgerEntry.findMany({
    where: { journal: { initiativeId: { not: null } }, account: { in: [...REAL_REVENUE_ACCOUNTS] } },
    select: { account: true, direction: true, amountCents: true, journal: { select: { initiativeId: true, contribution: { select: { type: true, walletSubscriptionId: true } } } } }
  });
  const byInitiative = new Map<number, LedgerPerInitiative>();
  for (const entry of entries) {
    const initiativeId = entry.journal.initiativeId;
    if (initiativeId === null) continue;
    const row = byInitiative.get(initiativeId) ?? emptyLedger();
    const signed = entry.direction === 'CREDIT' ? entry.amountCents : -entry.amountCents;
    switch (entry.account) {
      case 'KORUM_REVENUE_GUARANTEE':
        row.guarantee += signed;
        break;
      case 'KORUM_REVENUE_TICKET_FEE':
        row.ticketFee += signed;
        break;
      case 'KORUM_REVENUE_SPONSOR_FEE':
        row.sponsorFee += signed;
        break;
      case 'KORUM_REVENUE_TOPUP_FEE':
        row.topupFee += signed;
        break;
      case 'KORUM_REVENUE_BRACKET':
        row.bracketFee += signed;
        break;
      case 'KORUM_REVENUE_MAINTENANCE':
        row.maintFee += signed;
        break;
      case 'GATEWAY_FEES_RECOVERED':
        row.gatewayRecovered += signed;
        break;
      case 'AUTO_BOOST_EXPENSE':
        row.autoBoost -= signed;
        break;
      case 'CHARGEBACK_LOSSES':
        row.chargebacks -= signed;
        break;
      case 'GATEWAY_FEES_EXPENSE': {
        // Un gasto de pasarela está al debe: sube con cada cobro y baja si se corrige (un contra-asiento también cuenta).
        const cost = -signed;
        row.gatewayExpense += cost;
        const contribution = entry.journal.contribution;
        if (!contribution) break;
        if (contribution.type === 'TICKET') row.gatewayTicket += cost;
        else if (contribution.type === 'DONATION' && contribution.walletSubscriptionId !== null) row.gatewayHucha += cost;
        break;
      }
      default:
        break;
    }
    byInitiative.set(initiativeId, row);
  }
  return byInitiative;
}

export interface BiFacts {
  organizations: BiOrganizationFacts[];
  initiatives: BiInitiativeFacts[];
  truncated: boolean;
  /** Ingresos reales por entidad, en el formato de `calculateRealRevenueFromLedger`. */
  ledgerBalancesByOrganization: Awaited<ReturnType<typeof getBalancesByOrganization>>;
}

const addSample = (sample: GuaranteeSample, part: GuaranteeSample): void => {
  sample.contributions += part.contributions;
  sample.contributionsWithGuarantee += part.contributionsWithGuarantee;
  sample.guaranteeCents += part.guaranteeCents;
};

export async function loadBiFacts(db: Db, rules: KorumGlobalRulesCents): Promise<BiFacts> {
  const [organizations, openInitiatives, otherInitiatives, donations, sponsors, ledger, balances] = await Promise.all([
    db.organization.findMany({
      where: { archivedAt: null },
      orderBy: { name: 'asc' },
      select: {
        id: true, slug: true, name: true, province: true, health: true, medalRank: true, completedThisYear: true, completedHistorical: true, activeSponsorsCount: true, historicalSponsorsCount: true,
        customRules: true, ticketFeeFixedCents: true, ticketFeeBps: true, donationPresetsCents: true, defaultDonationIdx: true
      }
    }),
    // Las campañas abiertas entran siempre (proyección y KPIs): el tope solo recorta las ya terminadas, las más antiguas primero.
    db.initiative.findMany({ where: { organization: { archivedAt: null }, status: { in: [...BI_OPEN_STATUSES] } }, orderBy: { id: 'desc' }, select: INITIATIVE_SELECT }),
    db.initiative.findMany({
      where: { organization: { archivedAt: null }, status: { notIn: ['BUDGETING', 'CANCELLED', ...BI_OPEN_STATUSES] } },
      orderBy: { id: 'desc' },
      take: BI_MAX_INITIATIVES + 1,
      select: INITIATIVE_SELECT
    }),
    // Una sola consulta para el número de donaciones, su importe y la aportación voluntaria: agrupa por el valor de la garantía (pocos valores
    // distintos), así el número con garantía y su suma salen de la misma lectura y nunca pueden ser incoherentes entre sí.
    db.contribution.groupBy({ by: ['initiativeId', 'guaranteeContributionCents'], where: { type: 'DONATION', status: 'COMPLETED' }, _count: { _all: true }, _sum: { amountCents: true } }),
    db.sponsor.groupBy({ by: ['initiativeId'], where: { status: 'APPROVED', initiativeId: { not: null } }, _sum: { feeGeneratedCents: true } }),
    loadLedgerPerInitiative(db),
    getBalancesByOrganization(db, REAL_REVENUE_ACCOUNTS)
  ]);

  const truncated = otherInitiatives.length > BI_MAX_INITIATIVES;
  const visible = [...openInitiatives, ...(truncated ? otherInitiatives.slice(0, BI_MAX_INITIATIVES) : otherInitiatives)];
  const organizationById = new Map(organizations.map((organization) => [organization.id, organization]));
  const donationSample = new Map<number, GuaranteeSample & { amountCents: number }>();
  for (const row of donations) {
    const sample = donationSample.get(row.initiativeId) ?? { contributions: 0, contributionsWithGuarantee: 0, guaranteeCents: 0, amountCents: 0 };
    sample.contributions += row._count._all;
    sample.amountCents += row._sum.amountCents ?? 0;
    if (row.guaranteeContributionCents > 0) {
      sample.contributionsWithGuarantee += row._count._all;
      sample.guaranteeCents += row.guaranteeContributionCents * row._count._all;
    }
    donationSample.set(row.initiativeId, sample);
  }
  const sponsorFee = new Map(sponsors.map((row) => [row.initiativeId, row._sum.feeGeneratedCents ?? 0]));

  // Muestras de la aportación voluntaria: la de cada entidad (si ya tiene datos) y la de toda la plataforma.
  const platformSample: GuaranteeSample = { contributions: 0, contributionsWithGuarantee: 0, guaranteeCents: 0 };
  const entitySamples = new Map<string, GuaranteeSample>();
  const organizationOfInitiative = new Map<number, string>(visible.map((initiative) => [initiative.id, initiative.organizationId]));
  for (const [initiativeId, sample] of donationSample) {
    const organizationId = organizationOfInitiative.get(initiativeId);
    if (organizationId === undefined) continue; // Una iniciativa fuera de la vista (borrador, cancelada o archivada) no cuenta.
    addSample(platformSample, sample);
    const entity = entitySamples.get(organizationId) ?? { contributions: 0, contributionsWithGuarantee: 0, guaranteeCents: 0 };
    addSample(entity, sample);
    entitySamples.set(organizationId, entity);
  }

  const facts: BiInitiativeFacts[] = [];
  for (const initiative of visible) {
    const organization = organizationById.get(initiative.organizationId);
    if (!organization) continue;
    const money = ledger.get(initiative.id) ?? emptyLedger();
    const donation = donationSample.get(initiative.id);
    const realizedGuaranteeCents = money.guarantee;
    const projection = projectGuaranteeContributionsAt100({
      goalCents: initiative.goalCents,
      raisedCents: initiative.raisedCents,
      donationsCount: donation?.contributions ?? 0,
      donationsCents: donation?.amountCents ?? 0,
      realizedGuaranteeCents,
      defaultDonationTicketCents: organization.donationPresetsCents[organization.defaultDonationIdx] ?? 0,
      entitySample: entitySamples.get(initiative.organizationId) ?? { contributions: 0, contributionsWithGuarantee: 0, guaranteeCents: 0 },
      platformSample
    });
    const ticketing = initiative.format === 'TICKETING' && initiative.ticketPriceCents !== null && initiative.ticketMax !== null && initiative.ticketFeeMode !== null;
    const ticketPlan = ticketing
      ? calculateStudioTicketingTCO({
          ticketPriceCents: initiative.ticketPriceCents!,
          ticketMax: initiative.ticketMax!,
          feeMode: initiative.ticketFeeMode!,
          digitalFeeConfig: organization.customRules ? { fixedCents: organization.ticketFeeFixedCents, pctBps: organization.ticketFeeBps } : { fixedCents: rules.ticketFeeFixedCents, pctBps: rules.ticketFeeBps },
          gatewayConfig: { pctBps: rules.gatewayPctBps, fixedCents: rules.gatewayFixedCents },
          maintFeeCents: initiative.maintFeeCents
        })
      : null;
    // Lo ya cobrado más lo que dejarán las entradas que faltan por vender, al margen modelado de una entrada: la proyección nunca queda por
    // debajo de lo cobrado (las compras de varias entradas comparten el fijo de la pasarela, así que lo real suele superar al modelo).
    const ticketMarginRealizedCents = money.ticketFee - money.gatewayTicket;
    const remainingTickets = ticketPlan ? Math.max(0, initiative.ticketMax! - initiative.ticketsSold) : 0;
    // Sin plan de taquilla (campaña de presupuesto o sin precio) no hay nada que proyectar, pero lo ya cobrado no se pierde.
    const ticketMarginAt100Cents = ticketPlan ? ticketMarginRealizedCents + remainingTickets * ticketPlan.netKorumMarginPerTicketCents : ticketMarginRealizedCents;
    // En taquilla solo se cobra el mantenimiento que la recaudación cubre: lo que no alcanza no es ingreso (`maintShortfallCents`).
    const maintFeeCents = initiative.maintFeeCents - (ticketPlan?.maintShortfallCents ?? 0);
    facts.push({
      id: initiative.id,
      walletEscrowId: initiative.walletEscrowId,
      title: initiative.title,
      organizationId: organization.id,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      province: organization.province,
      status: initiative.status,
      format: initiative.format,
      quarter: initiative.quarter,
      closesAt: initiative.closesAt.toISOString(),
      goalCents: initiative.goalCents,
      raisedCents: initiative.raisedCents,
      totalContributions: initiative.totalContributions,
      bracketFeeCents: initiative.bracketFeeCents,
      maintFeeCents,
      gatewayFeeCents: initiative.gatewayFeeCents,
      absorbsGatewayCostByKorum: initiative.absorbsGatewayCostByKorum,
      realizedGuaranteeCents,
      projectedGuaranteeAt100Cents: projection.projectedCents,
      approvedSponsorsFeeCents: sponsorFee.get(initiative.id) ?? 0,
      ticketMarginAt100Cents,
      ticketMarginRealizedCents,
      huchaTopupNetCents: money.topupFee - money.gatewayHucha,
      settled: {
        sourcesCents: {
          bracketFeeCents: money.bracketFee,
          supportGuaranteeCents: money.guarantee,
          sponsorFeeCents: money.sponsorFee,
          digitalTicketFeeCents: money.ticketFee,
          maintFeeCents: money.maintFee,
          huchaTopupFeeCents: money.topupFee
        },
        costsCents: money.gatewayExpense - money.gatewayRecovered,
        sunkCostsCents: money.autoBoost + money.chargebacks
      },
      sunkCostsCents: money.autoBoost + money.chargebacks,
      selfBoostStandingCents: money.autoBoost
    });
  }

  return {
    organizations: organizations.map(
      (organization): BiOrganizationFacts => ({
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
        province: organization.province,
        health: organization.health,
        medalRank: organization.medalRank,
        completedThisYear: organization.completedThisYear,
        completedHistorical: organization.completedHistorical,
        activeSponsorsCount: organization.activeSponsorsCount,
        historicalSponsorsCount: organization.historicalSponsorsCount
      })
    ),
    initiatives: facts,
    truncated,
    ledgerBalancesByOrganization: balances
  };
}
