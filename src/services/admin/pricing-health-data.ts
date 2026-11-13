import type { RevenueSourceKey } from '@/core/finance/bi-analytics.service';
import { countOpenPricingAlerts, evaluatePricingHealth, reviewPricingAlerts, type PricingAcknowledgement, type PricingAlertCode, type ReviewedPricingAlert } from '@/core/finance/pricing-health';
import type { Prisma } from '@/generated/prisma/client';
import type { LedgerAccount } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import { getSetting } from '@/services/settings/settings.service';
import { loadGlobalRules } from './bi-facts';

/**
 * Salud de precios de la consola (Sprint 5.1, skill korum-tco-calculator §2.1): las reglas de precio frente a lo que de verdad pasa en el
 * libro mayor. Consultas agregadas y baratas, porque también las pide la cabecera de cada página de la consola.
 * Quien llama ya pasó `authorizeSuperadmin`.
 */

/**
 * Margen de una fuente con cobro propio: ingreso de KORUM de los cobros **completados** menos la pasarela de esos mismos cobros. Un cobro devuelto o
 * contracargado no cuenta en ningún lado: su pérdida (la pasarela que no se recupera) es el coste de la garantía de devolución, no un precio mal
 * puesto, y no debe disparar un aviso de precios. Acumulado de todo el libro: no hay periodo.
 */
async function completedMarginCents(db: Db, account: LedgerAccount, contribution: Prisma.ContributionWhereInput): Promise<{ income: number; cost: number }> {
  const completed = { ...contribution, status: 'COMPLETED' as const };
  const net = async (account: LedgerAccount) => {
    const rows = await db.escrowLedgerEntry.groupBy({ by: ['direction'], where: { account, journal: { contribution: completed } }, _sum: { amountCents: true } });
    const sum = (direction: 'DEBIT' | 'CREDIT') => rows.find((row) => row.direction === direction)?._sum.amountCents ?? 0;
    return { debit: sum('DEBIT'), credit: sum('CREDIT') };
  };
  const [revenue, gateway] = await Promise.all([net(account), net('GATEWAY_FEES_EXPENSE')]);
  // Netos en su sentido natural: el ingreso crece al haber y el gasto al debe; un contra-asiento (de uno u otro) resta.
  return { income: revenue.credit - revenue.debit, cost: gateway.debit - gateway.credit };
}

/**
 * Margen real acumulado de las tres fuentes que tienen un cobro propio (entradas, patrocinios y aportaciones mensuales de Mi Hucha). Las otras
 * tres (tramos, aportación voluntaria y mantenimiento) no tienen cobro propio: su pasarela va dentro de la meta de cada campaña. Una fuente
 * sin movimientos no aparece (no hay margen que juzgar).
 */
export async function loadRealSourceMargins(db: Db): Promise<Partial<Record<RevenueSourceKey, number>>> {
  const [ticket, sponsor, hucha] = await Promise.all([
    completedMarginCents(db, 'KORUM_REVENUE_TICKET_FEE', { type: 'TICKET' }),
    completedMarginCents(db, 'KORUM_REVENUE_SPONSOR_FEE', { type: 'SPONSORSHIP' }),
    completedMarginCents(db, 'KORUM_REVENUE_TOPUP_FEE', { type: 'DONATION', walletSubscriptionId: { not: null } })
  ]);
  const margins: Partial<Record<RevenueSourceKey, number>> = {};
  const sources: Array<[RevenueSourceKey, { income: number; cost: number }]> = [
    ['digitalTicketFeeCents', ticket],
    ['sponsorFeeCents', sponsor],
    ['huchaTopupFeeCents', hucha]
  ];
  for (const [key, { income, cost }] of sources) if (income !== 0 || cost !== 0) margins[key] = income - cost;
  return margins;
}

export interface PricingHealthView {
  alerts: ReviewedPricingAlert[];
  /** Avisos sin aceptar y, de ellos, los críticos: la insignia de la cabecera y el banner de la portada. */
  open: number;
  openCritical: number;
  /** Los márgenes reales y las aceptaciones guardadas: el motor de reglas recalcula los avisos con ellos mientras se escribe (Sprint 5.3). */
  margins: Partial<Record<RevenueSourceKey, number>>;
  acknowledgements: PricingAcknowledgement[];
}

export async function loadPricingHealth(db: Db): Promise<PricingHealthView> {
  const [rules, margins, acknowledgements] = await Promise.all([loadGlobalRules(db), loadRealSourceMargins(db), getSetting(db, 'pricing.acknowledgements')]);
  // Un código guardado que ya no existe no coincide con ningún aviso: simplemente no aplica.
  const saved: PricingAcknowledgement[] = (acknowledgements ?? []).map((acknowledgement) => ({ ...acknowledgement, code: acknowledgement.code as PricingAlertCode }));
  const alerts = reviewPricingAlerts(evaluatePricingHealth(rules, margins), saved);
  return { alerts, ...countOpenPricingAlerts(alerts), margins, acknowledgements: saved };
}
