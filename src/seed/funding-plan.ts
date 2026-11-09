import { bpsOf } from '@/core/finance/money';
import type { ContributionType, PaymentMethod } from '@/generated/prisma/enums';
import { createRandom, pickWeighted, seedFromText, splitEuros, type Random } from './random';
import type { KorumSeedData } from './seed-types';

/**
 * Reparto determinista de lo recaudado por cada iniciativa en pagos concretos. Es una función PURA: dado el JSON de la
 * semilla produce siempre los mismos pagos, y comprueba que suman exactamente `raisedCents`, que su número es
 * `totalContributions` y que las entradas vendidas son `ticketsSold`. Cualquier descuadre lanza `SeedPlanError`.
 */

/** «Hoy» de la semilla: fija, para que los datos no dependan del reloj de quien la ejecute. */
export const SEED_NOW = new Date('2026-10-29T12:00:00.000Z');
const DAY_MS = 86_400_000;
/** Duración de las campañas de la semilla: por debajo del máximo (`GlobalConfig.maxCampaignDays`, 60 días). */
const CAMPAIGN_DAYS = 50;
/** Parte de las donaciones que marca la aportación voluntaria (va desmarcada por defecto; el resto no la paga). */
const GUARANTEE_ACTIVATION = 0.3;
/**
 * IVA que se suma al fee de gestión publicitaria de los comercios (Regla 02 §5): 21 %, el tipo de las facturas de la
 * semilla. Provisional hasta que lo confirme la asesoría fiscal (tarea aplazada). La comisión por tramos de las entidades
 * NO lleva IVA asentado: su factura de ejemplo es un documento informativo y esa cuestión sigue abierta.
 */
export const SEED_VAT_BPS = 2100;
const MAX_TICKETS_PER_PURCHASE = 4;

export class SeedPlanError extends Error {
  constructor(initiativeId: number, detail: string) {
    super(`Semilla incoherente en la iniciativa ${initiativeId}: ${detail}`);
    this.name = 'SeedPlanError';
  }
}

export interface PlannedPayment {
  key: string;
  type: Extract<ContributionType, 'DONATION' | 'TICKET' | 'SPONSORSHIP'>;
  /** Céntimos que suman a la hucha de la iniciativa. */
  amountCents: number;
  /** Aportación voluntaria a KORUM (ingreso de KORUM; no suma a la meta). */
  guaranteeCents: number;
  /** Gastos de gestión digital (entradas) o fee del patrocinio: ingreso de KORUM además de la aportación. */
  serviceFeeCents: number;
  /** IVA del fee de un patrocinio (a pagar a Hacienda, no es ingreso de KORUM). 0 en donaciones y entradas. */
  taxCents: number;
  totalChargedCents: number;
  /** Comisión de Paycomet de este cobro (gasto de KORUM). */
  gatewayFeeCents: number;
  paymentMethod: PaymentMethod;
  createdAt: Date;
  email: string;
  groupName: string | null;
  quantity: number;
  sponsorId: number | null;
  /** Lo que la bolsa Matching 2x liberó por esta donación. */
  matchedBonusCents: number;
}

export interface PlannedMatching {
  key: string;
  paymentKey: string;
  sponsorId: number;
  amountCents: number;
  createdAt: Date;
}

export interface PlannedPoolPayin {
  key: string;
  sponsorId: number;
  poolCents: number;
  serviceFeeCents: number;
  taxCents: number;
  gatewayFeeCents: number;
  paidAt: Date;
}

export interface InitiativeFundingPlan {
  initiativeId: number;
  organizationId: string;
  payments: PlannedPayment[];
  matching: PlannedMatching[];
  poolPayins: PlannedPoolPayin[];
  firstPayinAt: Date | null;
}

const PAYMENT_METHODS: ReadonlyArray<readonly [PaymentMethod, number]> = [
  ['BIZUM', 5],
  ['CARD', 3.5],
  ['APPLE_PAY', 0.8],
  ['GOOGLE_PAY', 0.7]
];

/** Quita de `count` huecos de tiempo ordenados dentro de [from, to]. */
function sortedTimes(random: Random, count: number, from: number, to: number): Date[] {
  return Array.from({ length: count }, () => from + random() * (to - from))
    .sort((a, b) => a - b)
    .map((time) => new Date(Math.floor(time / 1000) * 1000));
}

export function planInitiativeFunding(seed: KorumSeedData, initiativeId: number): InitiativeFundingPlan {
  const initiative = seed.initiatives.find((candidate) => candidate.id === initiativeId);
  if (!initiative) throw new SeedPlanError(initiativeId, 'no existe');
  const org = seed.schools.find((candidate) => candidate.id === initiative.organizationId);
  if (!org) throw new SeedPlanError(initiativeId, `la entidad ${initiative.organizationId} no existe`);

  const { gatewayPctBps, gatewayFixedCents } = seed.globalRules;
  const gatewayFee = (totalCents: number) => bpsOf(totalCents, gatewayPctBps) + gatewayFixedCents;
  const random = createRandom(seedFromText(`funding:${initiativeId}`));

  const closes = new Date(initiative.closesAt).getTime();
  const end = Math.min(closes, SEED_NOW.getTime());
  const start = closes - CAMPAIGN_DAYS * DAY_MS;
  const span = end - start;
  // Las campañas duran CAMPAIGN_DAYS (menos que el máximo de 60 de la ventana de 90 días de Paycomet): si una cierra tan
  // lejos que empezaría después de «hoy», no habría podido cobrar nada todavía y la semilla es incoherente.
  if (span < 3 * DAY_MS) throw new SeedPlanError(initiativeId, `cierra el ${initiative.closesAt}: no habría tenido tiempo de recaudar antes de hoy`);

  const sponsors = seed.sponsors.filter((sponsor) => sponsor.initiativeId === initiativeId && sponsor.status === 'APPROVED');
  const pools = sponsors.filter((sponsor) => sponsor.isMatchingPool);
  const direct = sponsors.filter((sponsor) => !sponsor.isMatchingPool);
  const poolTotal = initiative.matchingPoolTotalCents ?? 0;
  const matchingReleased = poolTotal - (initiative.matchingPoolRemainingCents ?? 0);
  if (pools.length > 1) throw new SeedPlanError(initiativeId, 'solo se admite una bolsa Matching 2x por iniciativa');
  if (pools.reduce((sum, pool) => sum + pool.amountCents, 0) !== poolTotal) throw new SeedPlanError(initiativeId, 'la bolsa Matching 2x no coincide con su patrocinador');

  const sponsorCents = direct.reduce((sum, sponsor) => sum + sponsor.amountCents, 0);
  const peopleCount = initiative.totalContributions - direct.length - pools.length;
  const peopleCents = initiative.raisedCents - sponsorCents - matchingReleased;
  if (peopleCount <= 0 || peopleCents <= 0) throw new SeedPlanError(initiativeId, 'no quedan aportaciones de familias tras patrocinios y bolsa');

  const groups = initiative.courses.map((course) => [course.groupName, course.familiesCount] as const);
  const poolSize = Math.max(1, Math.ceil(peopleCount * 0.8));
  const emailFor = () => `familia-${String(initiativeId).padStart(2, '0')}-${String(Math.floor(random() * poolSize)).padStart(3, '0')}@familias.example`;
  const people: Omit<PlannedPayment, 'key' | 'createdAt' | 'matchedBonusCents'>[] = [];

  if (initiative.format === 'TICKETING') {
    const price = initiative.ticketPriceCents ?? 0;
    const sold = initiative.ticketsSold ?? 0;
    if (initiative.ticketFeeMode !== 'ADD') throw new SeedPlanError(initiativeId, 'la semilla solo modela los gastos de gestión digital en modo ADD');
    if (sold * price !== peopleCents) throw new SeedPlanError(initiativeId, `entradas vendidas × precio (${sold * price}) no coincide con lo recaudado (${peopleCents})`);
    if (sold < peopleCount || sold > peopleCount * MAX_TICKETS_PER_PURCHASE) throw new SeedPlanError(initiativeId, 'las entradas vendidas no caben en el número de compras');
    const quantities = Array<number>(peopleCount).fill(1);
    for (let extra = sold - peopleCount; extra > 0; ) {
      const index = Math.floor(random() * peopleCount);
      if (quantities[index]! < MAX_TICKETS_PER_PURCHASE) {
        quantities[index]! += 1;
        extra -= 1;
      }
    }
    const feePerTicket = org.ticketFeeFixedCents + bpsOf(price, org.ticketFeeBps);
    for (const quantity of quantities) {
      const amountCents = quantity * price;
      const serviceFeeCents = quantity * feePerTicket;
      const totalChargedCents = amountCents + serviceFeeCents;
      people.push({
        type: 'TICKET',
        amountCents,
        guaranteeCents: 0,
        serviceFeeCents,
        taxCents: 0,
        totalChargedCents,
        gatewayFeeCents: gatewayFee(totalChargedCents),
        paymentMethod: pickWeighted(random, PAYMENT_METHODS),
        email: emailFor(),
        groupName: groups.length > 0 ? pickWeighted(random, groups) : null,
        quantity,
        sponsorId: null
      });
    }
  } else {
    if (peopleCents % 100 !== 0) throw new SeedPlanError(initiativeId, 'las donaciones deben sumar euros enteros');
    for (const euros of splitEuros(random, peopleCents / 100, peopleCount)) {
      const guaranteeCents = random() < GUARANTEE_ACTIVATION ? org.fullIntegrityCheckCents : 0;
      const amountCents = euros * 100;
      const totalChargedCents = amountCents + guaranteeCents;
      people.push({
        type: 'DONATION',
        amountCents,
        guaranteeCents,
        serviceFeeCents: 0,
        taxCents: 0,
        totalChargedCents,
        gatewayFeeCents: gatewayFee(totalChargedCents),
        paymentMethod: pickWeighted(random, PAYMENT_METHODS),
        email: emailFor(),
        groupName: groups.length > 0 ? pickWeighted(random, groups) : null,
        quantity: 1,
        sponsorId: null
      });
    }
  }

  const times = sortedTimes(random, people.length, start + span * 0.05, end);
  const sponsorTimes = sortedTimes(random, direct.length, start + span * 0.02, start + span * 0.3);
  const planned: PlannedPayment[] = people.map((person, index) => ({ ...person, key: '', createdAt: times[index]!, matchedBonusCents: 0 }));
  direct.forEach((sponsor, index) => {
    const taxCents = bpsOf(sponsor.feeGeneratedCents, SEED_VAT_BPS);
    const totalChargedCents = sponsor.amountCents + sponsor.feeGeneratedCents + taxCents;
    planned.push({
      key: '',
      type: 'SPONSORSHIP',
      amountCents: sponsor.amountCents,
      guaranteeCents: 0,
      serviceFeeCents: sponsor.feeGeneratedCents,
      taxCents,
      totalChargedCents,
      gatewayFeeCents: gatewayFee(totalChargedCents),
      paymentMethod: 'CARD',
      createdAt: sponsorTimes[index]!,
      email: sponsor.email.toLowerCase(),
      groupName: null,
      quantity: 1,
      sponsorId: sponsor.id,
      matchedBonusCents: 0
    });
  });
  planned.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.amountCents - b.amountCents);
  const counters: Record<string, number> = {};
  for (const payment of planned) {
    counters[payment.type] = (counters[payment.type] ?? 0) + 1;
    payment.key = `i${initiativeId}-${payment.type.toLowerCase()}-${String(counters[payment.type]).padStart(4, '0')}`;
  }

  // Matching 2x: la bolsa se activa en el tramo final y empareja las donaciones más recientes hasta lo ya liberado.
  const matching: PlannedMatching[] = [];
  const poolSponsor = pools[0];
  let toRelease = matchingReleased;
  if (poolSponsor) {
    for (const payment of [...planned].reverse()) {
      if (toRelease === 0) break;
      if (payment.type !== 'DONATION') continue;
      const released = Math.min(payment.amountCents, toRelease);
      payment.matchedBonusCents = released;
      toRelease -= released;
      matching.push({ key: `${payment.key}-match`, paymentKey: payment.key, sponsorId: poolSponsor.id, amountCents: released, createdAt: new Date(payment.createdAt.getTime() + 1000) });
    }
    matching.reverse();
  }
  if (toRelease !== 0) throw new SeedPlanError(initiativeId, `no hay donaciones suficientes para liberar la bolsa (faltan ${toRelease} céntimos)`);

  // La bolsa se cobra justo antes de la primera donación que empareja (así no queda ninguna donación posterior sin emparejar
  // mientras haya saldo); si todavía no ha liberado nada, al inicio de la campaña.
  const poolPaidAt = matching[0] ? new Date(matching[0].createdAt.getTime() - 6 * 3_600_000) : new Date(start + span * 0.1);
  const poolPayins: PlannedPoolPayin[] = pools.map((pool) => {
    const taxCents = bpsOf(pool.feeGeneratedCents, SEED_VAT_BPS);
    return {
      key: `i${initiativeId}-pool-${pool.id}`,
      sponsorId: pool.id,
      poolCents: pool.amountCents,
      serviceFeeCents: pool.feeGeneratedCents,
      taxCents,
      gatewayFeeCents: gatewayFee(pool.amountCents + pool.feeGeneratedCents + taxCents),
      paidAt: poolPaidAt
    };
  });

  const raised = planned.reduce((sum, payment) => sum + payment.amountCents, 0) + matching.reduce((sum, release) => sum + release.amountCents, 0);
  if (raised !== initiative.raisedCents) throw new SeedPlanError(initiativeId, `los pagos suman ${raised} y lo recaudado es ${initiative.raisedCents}`);
  // El cobro de un comercio con bolsa Matching 2x también es una aportación (💛), como en la aplicación (`completeSponsorshipInTx`).
  if (planned.length + poolPayins.length !== initiative.totalContributions) throw new SeedPlanError(initiativeId, `${planned.length + poolPayins.length} pagos y totalContributions es ${initiative.totalContributions}`);
  if (initiative.format === 'TICKETING' && planned.reduce((sum, payment) => sum + payment.quantity, 0) !== initiative.ticketsSold) {
    throw new SeedPlanError(initiativeId, 'las entradas de los pases no suman las vendidas');
  }

  const allTimes = [...planned.map((payment) => payment.createdAt), ...poolPayins.map((payin) => payin.paidAt)];
  const firstPayinAt = allTimes.length > 0 ? new Date(Math.min(...allTimes.map((time) => time.getTime()))) : null;
  return { initiativeId, organizationId: org.id, payments: planned, matching, poolPayins, firstPayinAt };
}

export function planAllFunding(seed: KorumSeedData): InitiativeFundingPlan[] {
  return seed.initiatives.map((initiative) => planInitiativeFunding(seed, initiative.id));
}
