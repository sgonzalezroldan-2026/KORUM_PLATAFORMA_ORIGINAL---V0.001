import { bpsOf } from '@/core/finance/money';
import { getAccountBalance, getRaisedFromLedger, getTrialBalance } from '@/core/finance/ledger.service';
import type { LedgerAccount } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';
import { SEED_VAT_BPS } from './funding-plan';
import type { KorumSeedData } from './seed-types';

/**
 * Conciliación final de la semilla (QA-C04): los saldos del libro mayor deben coincidir con los contadores de las
 * iniciativas y con la propia semilla, con 0 céntimos de desviación. Lanza `SeedReconciliationError` con todos los
 * problemas a la vez; si todo cuadra, devuelve un informe.
 *
 * Las comprobaciones cruzan fuentes DISTINTAS (el JSON de la semilla, las tablas de negocio y el libro mayor) y no repiten la
 * lógica del planificador: así detectan tanto un error del planificador como datos viejos que `update: {}` no corrige.
 */

export class SeedReconciliationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`La semilla no cuadra:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'SeedReconciliationError';
    this.problems = problems;
  }
}

export interface SeedInitiativeReport {
  id: number;
  status: string;
  raisedCents: number;
  ledgerRaisedCents: number;
  escrowBalanceCents: number;
  contributions: number;
}

export interface SeedReport {
  organizations: number;
  initiatives: SeedInitiativeReport[];
  contributions: number;
  ticketPasses: number;
  ledgerDebitCents: number;
  ledgerCreditCents: number;
  journals: number;
}

type Check = (condition: boolean, message: string) => void;

const PEOPLE_TYPES = ['DONATION', 'TICKET', 'SPONSORSHIP'] as const;
const PAYIN_KINDS = ['PAYIN_DONATION', 'PAYIN_TICKET', 'PAYIN_SPONSOR'] as const;
/** Solo los asientos de la semilla: las altas posteriores de desarrollo no deben hacer fallar una nueva ejecución. */
const SEEDED = { idempotencyKey: { startsWith: 'seed:' } } as const;

async function seededBalance(db: KorumPrismaClient, account: LedgerAccount, side: 'DEBIT' | 'CREDIT'): Promise<number> {
  const sum = await db.escrowLedgerEntry.aggregate({ where: { account, direction: side, journal: SEEDED }, _sum: { amountCents: true } });
  return sum._sum.amountCents ?? 0;
}

async function verifyInitiative(db: KorumPrismaClient, seed: KorumSeedData, initiative: KorumSeedData['initiatives'][number], check: Check): Promise<SeedInitiativeReport | null> {
  const stored = await db.initiative.findUnique({ where: { id: initiative.id } });
  if (!stored) {
    check(false, `falta la iniciativa ${initiative.id}`);
    return null;
  }
  const id = initiative.id;
  const label = `iniciativa ${id}`;
  const settled = initiative.status === 'CLOSED';

  // 1. La base coincide con el JSON de la semilla (no con el planificador).
  check(
    stored.goalCents === initiative.goalCents && stored.status === initiative.status && stored.raisedCents === initiative.raisedCents && stored.totalContributions === initiative.totalContributions,
    `${label}: la base (${stored.status}, meta ${stored.goalCents}, recaudado ${stored.raisedCents}, ${stored.totalContributions} aportaciones) no coincide con la semilla; ejecuta npm run db:reset`
  );

  // 2. Libro mayor ↔ contador de la iniciativa ↔ hucha.
  const ledgerRaised = await getRaisedFromLedger(db, id);
  const escrow = (await getAccountBalance(db, 'INITIATIVE_ESCROW', { initiativeId: id })).balanceCents;
  const contributions = await db.contribution.count({ where: { initiativeId: id, status: 'COMPLETED', type: { in: [...PEOPLE_TYPES] } } });
  check(ledgerRaised === stored.raisedCents, `${label}: el libro suma ${ledgerRaised} y raisedCents es ${stored.raisedCents}`);
  check(escrow === (settled ? 0 : stored.raisedCents), `${label}: la hucha tiene ${escrow} céntimos y debería tener ${settled ? 0 : stored.raisedCents}`);
  check(contributions === stored.totalContributions, `${label}: ${contributions} aportaciones y totalContributions es ${stored.totalContributions}`);

  // 3. Tabla de aportaciones ↔ libro: lo abonado a la hucha y lo cobrado por la pasarela salen de las filas de `Contribution`.
  const rows = await db.contribution.aggregate({ where: { initiativeId: id, status: 'COMPLETED' }, _sum: { amountCents: true } });
  check((rows._sum.amountCents ?? 0) === initiative.raisedCents, `${label}: las aportaciones suman ${rows._sum.amountCents ?? 0} y la semilla dice ${initiative.raisedCents}`);
  const charged = await db.contribution.aggregate({ where: { initiativeId: id, status: 'COMPLETED', type: { in: [...PEOPLE_TYPES] } }, _sum: { totalChargedCents: true } });
  const pspIn = await db.escrowLedgerEntry.aggregate({
    where: { account: 'PSP_CLEARING', direction: 'DEBIT', journal: { initiativeId: id, kind: { in: [...PAYIN_KINDS] }, contributionId: { not: null } } },
    _sum: { amountCents: true }
  });
  check((charged._sum.totalChargedCents ?? 0) === (pspIn._sum.amountCents ?? 0), `${label}: lo cobrado en las aportaciones (${charged._sum.totalChargedCents ?? 0}) no coincide con lo que entró por la pasarela en el libro (${pspIn._sum.amountCents ?? 0})`);

  // 4. Cuadre de la meta según su formato.
  if (initiative.format === 'BUDGET') {
    const gatewayInGoal = initiative.absorbsGatewayCostByKorum ? 0 : initiative.gatewayFeeCents;
    const net = initiative.costMatCents + initiative.costInstCents + Math.round(((initiative.costMatCents + initiative.costInstCents) * initiative.contingencyBps) / 10_000);
    check(net + initiative.bracketFeeCents + initiative.maintFeeCents + gatewayInGoal === initiative.goalCents, `${label}: el presupuesto no suma goalCents`);
    check(initiative.goalCents % 100 === 0, `${label}: goalCents no es un euro entero`);
  } else {
    check((initiative.ticketPriceCents ?? 0) * (initiative.ticketMax ?? 0) === initiative.goalCents, `${label}: precio × aforo no suma goalCents`);
    const passes = await db.ticketPass.aggregate({ where: { initiativeId: id }, _sum: { quantity: true }, _count: true });
    check(passes._sum.quantity === initiative.ticketsSold, `${label}: los pases suman ${passes._sum.quantity} entradas y ticketsSold es ${initiative.ticketsSold}`);
    check(passes._count === initiative.totalContributions, `${label}: ${passes._count} pases y ${initiative.totalContributions} compras`);
  }

  // 5. Bolsa Matching 2x.
  if (initiative.matchingPoolTotalCents) {
    const pool = (await getAccountBalance(db, 'MATCHING_POOL', { initiativeId: id })).balanceCents;
    check(pool === initiative.matchingPoolRemainingCents, `${label}: la bolsa Matching 2x tiene ${pool} y debería tener ${initiative.matchingPoolRemainingCents}`);
  }

  // 6. Liquidación: solo las campañas con la meta lograda la tienen y su reparto suma lo recaudado.
  const payout = await db.escrowPayout.findUnique({ where: { initiativeId: id }, include: { signatures: true } });
  const reached = initiative.status === 'GOAL_REACHED' || settled;
  check(Boolean(payout) === reached, `${label}: ${reached ? 'falta' : 'sobra'} la liquidación`);
  if (payout) {
    const gatewayInGoal = initiative.absorbsGatewayCostByKorum ? 0 : initiative.gatewayFeeCents;
    check(payout.netPaidCents + payout.korumFeeSettledCents + gatewayInGoal === initiative.raisedCents, `${label}: la liquidación (${payout.netPaidCents} + comisión ${payout.korumFeeSettledCents} + pasarela ${gatewayInGoal}) no suma lo recaudado`);
    check(payout.destinationType === 'ORGANIZATION', `${label}: la liquidación debe ir a la entidad, no a un tercero`);
    check(payout.status === (settled ? 'EXECUTED' : 'PENDING_DOUBLE_CHECK'), `${label}: estado de la liquidación ${payout.status}`);
    const roles = payout.signatures.map((signature) => signature.signerRole).sort();
    const distinctSigners = new Set(payout.signatures.map((signature) => signature.signerUserId)).size;
    check(settled ? roles.join() === 'COSIGNER,DIRECTOR' && distinctSigners === 2 : roles.join() === 'DIRECTOR', `${label}: firmas de la liquidación ${roles.join('+') || 'ninguna'}`);
    check(seed.schools.some((school) => school.id === payout.organizationId && school.iban === payout.beneficiaryIban), `${label}: el IBAN de la liquidación no es el de la entidad`);
  }

  return { id, status: initiative.status, raisedCents: stored.raisedCents, ledgerRaisedCents: ledgerRaised, escrowBalanceCents: escrow, contributions };
}

/** Cuentas globales de la semilla: IVA, garantía, liquidaciones y pasarela. */
async function verifyAccounts(db: KorumPrismaClient, seed: KorumSeedData, check: Check): Promise<void> {
  // IVA de los patrocinios: calculado desde el JSON de comercios, no desde el planificador.
  const expectedVat = seed.sponsors
    .filter((sponsor) => sponsor.status === 'APPROVED')
    .reduce((sum, sponsor) => sum + bpsOf(sponsor.feeGeneratedCents, SEED_VAT_BPS), 0);
  const vat = await seededBalance(db, 'TAX_PAYABLE_VAT', 'CREDIT');
  check(vat === expectedVat, `el IVA repercutido en el libro es ${vat} y los patrocinios aprobados de la semilla generan ${expectedVat}`);

  // Garantía voluntaria: lo que dicen las aportaciones es lo que ingresa KORUM.
  const guarantee = await db.contribution.aggregate({ where: { status: 'COMPLETED', paycometOrder: { startsWith: 'SEED-' } }, _sum: { guaranteeContributionCents: true } });
  const guaranteeLedger = await seededBalance(db, 'KORUM_REVENUE_GUARANTEE', 'CREDIT');
  check(guaranteeLedger === (guarantee._sum.guaranteeContributionCents ?? 0), `la aportación voluntaria en el libro (${guaranteeLedger}) no coincide con las aportaciones (${guarantee._sum.guaranteeContributionCents ?? 0})`);

  // Lo liquidado a las entidades ya está transferido: nada queda por pagar y la pasarela no puede quedar en negativo.
  const payable = (await seededBalance(db, 'ORG_PAYABLE', 'CREDIT')) - (await seededBalance(db, 'ORG_PAYABLE', 'DEBIT'));
  check(payable === 0, `quedan ${payable} céntimos por pagar a las entidades en liquidaciones ya ejecutadas`);
  const pspBalance = (await seededBalance(db, 'PSP_CLEARING', 'DEBIT')) - (await seededBalance(db, 'PSP_CLEARING', 'CREDIT'));
  check(pspBalance >= 0, `la cuenta de la pasarela está en negativo (${pspBalance})`);

  // Aislamiento entre entidades en el propio libro: ningún asiento ni apunte de una iniciativa pertenece a otra entidad. Las claves
  // foráneas solo garantizan que existan; esta es la comprobación de coherencia (`postJournal` hace lo mismo al registrar).
  const owner = new Map(seed.initiatives.map((initiative) => [initiative.id, initiative.organizationId]));
  const journalPairs = await db.ledgerJournal.groupBy({ by: ['organizationId', 'initiativeId'], where: { ...SEEDED, initiativeId: { not: null } } });
  const entryPairs = await db.escrowLedgerEntry.groupBy({ by: ['organizationId', 'initiativeId'], where: { journal: SEEDED, initiativeId: { not: null } } });
  for (const [label, pairs] of [['asiento', journalPairs], ['apunte', entryPairs]] as const) {
    for (const pair of pairs) {
      check(pair.initiativeId !== null && owner.get(pair.initiativeId) === pair.organizationId, `un ${label} de la iniciativa ${pair.initiativeId} está a nombre de la entidad ${pair.organizationId} y no de ${owner.get(pair.initiativeId ?? -1)}`);
    }
  }

  // Las facturas de la semilla tienen un IVA coherente consigo mismas (documentos informativos, ver `seed-funding`).
  for (const invoice of seed.invoices) {
    check(invoice.baseAmountCents + invoice.taxAmountCents === invoice.totalAmountCents && invoice.taxAmountCents === bpsOf(invoice.baseAmountCents, invoice.taxRateBps), `factura ${invoice.invoiceNumber}: base + IVA no suma el total`);
  }
}

/**
 * Cupos (Regla 02 §2): lo que le queda a cada entidad es su límite menos lo reservado por TODAS sus campañas activas del curso, incluidas
 * las altas posteriores de desarrollo, y ningún curso consume más exento que el límite. A las sembradas se les exige además su instantánea
 * y una verificación de la entidad anterior a su publicación: detecta también una semilla vieja.
 */
async function verifyQuotas(db: KorumPrismaClient, seed: KorumSeedData, check: Check): Promise<void> {
  for (const school of seed.schools) {
    const org = await db.organization.findUniqueOrThrow({
      where: { id: school.id },
      select: { exemptLimitCents: true, exemptRemainingCents: true, medalGrantAvailableCents: true, medalRank: true, maintPaidCents: true, maintAnnualCapCents: true, quotaPeriod: true, kybReviewedAt: true }
    });
    const reservations = await db.initiative.findMany({
      where: { organizationId: school.id, quotaReservedAt: { not: null } },
      select: { id: true, quotaReservedAt: true, quotaReleasedAt: true, quotaReservedExemptCents: true, quotaReservedMedalCents: true, quotaReservedMaintCents: true, quotaReservedPeriod: true, defaultExemptAppliedCents: true, medalExemptAppliedCents: true, maintFeeCents: true }
    });
    const seededIds = new Set(seed.initiatives.map((initiative) => initiative.id));
    const seeded = reservations.filter((row) => seededIds.has(row.id));
    check(seeded.length === seed.initiatives.filter((initiative) => initiative.organizationId === school.id).length, `${school.id}: faltan reservas de cupos en sus campañas; ejecuta npm run db:reset`);
    const exemptByPeriod = new Map<string, number>();
    let currentExempt = 0;
    let currentMedal = 0;
    let currentMaint = 0;
    for (const row of seeded) {
      check(
        row.quotaReleasedAt === null && row.quotaReservedPeriod !== null && row.quotaReservedExemptCents === row.defaultExemptAppliedCents && row.quotaReservedMedalCents === row.medalExemptAppliedCents && row.quotaReservedMaintCents === row.maintFeeCents,
        `iniciativa ${row.id}: su reserva de cupos no coincide con lo que aplica; ejecuta npm run db:reset`
      );
      check(org.kybReviewedAt !== null && row.quotaReservedAt !== null && org.kybReviewedAt <= row.quotaReservedAt, `iniciativa ${row.id}: se publicó antes de verificar a la entidad; ejecuta npm run db:reset`);
    }
    for (const row of reservations.filter((candidate) => candidate.quotaReleasedAt === null)) {
      const period = row.quotaReservedPeriod ?? '';
      exemptByPeriod.set(period, (exemptByPeriod.get(period) ?? 0) + row.quotaReservedExemptCents);
      if (period === org.quotaPeriod) {
        currentExempt += row.quotaReservedExemptCents;
        currentMedal += row.quotaReservedMedalCents;
        currentMaint += row.quotaReservedMaintCents;
      }
    }
    for (const [period, exempt] of exemptByPeriod) check(exempt <= org.exemptLimitCents, `${school.id}: en ${period} usa ${exempt} de exento y su límite anual es ${org.exemptLimitCents}`);
    const medalGrant = seed.medalsConfig.find((tier) => tier.rank === org.medalRank)?.grantCents ?? 0;
    check(org.exemptRemainingCents === org.exemptLimitCents - currentExempt, `${school.id}: le quedan ${org.exemptRemainingCents} de exento y deberían ser ${org.exemptLimitCents - currentExempt}`);
    check(org.medalGrantAvailableCents === medalGrant - currentMedal, `${school.id}: le quedan ${org.medalGrantAvailableCents} de beca y deberían ser ${medalGrant - currentMedal}`);
    check(org.maintPaidCents === currentMaint && org.maintPaidCents <= org.maintAnnualCapCents, `${school.id}: mantenimiento acumulado ${org.maintPaidCents} y sus campañas reservan ${currentMaint}`);
  }
}

export async function verifySeed(db: KorumPrismaClient, seed: KorumSeedData): Promise<SeedReport> {
  const problems: string[] = [];
  const check: Check = (condition, message) => {
    if (!condition) problems.push(message);
  };

  const orgCount = await db.organization.count({ where: { id: { in: seed.schools.map((school) => school.id) } } });
  check(orgCount === seed.schools.length, `hay ${orgCount} entidades y la semilla define ${seed.schools.length}`);
  for (const school of seed.schools) {
    const members = await db.organizationMember.findMany({ where: { organizationId: school.id, role: { in: ['DIRECTOR', 'COSIGNER'] } } });
    const roles = new Set(members.map((member) => member.role));
    check(roles.has('DIRECTOR') && roles.has('COSIGNER') && new Set(members.map((member) => member.userId)).size === 2, `${school.id}: necesita un DIRECTOR y un COSIGNER distintos`);
  }

  const initiatives: SeedInitiativeReport[] = [];
  for (const initiative of seed.initiatives) {
    const report = await verifyInitiative(db, seed, initiative, check);
    if (report) initiatives.push(report);
  }
  await verifyAccounts(db, seed, check);
  await verifyQuotas(db, seed, check);

  const trial = await getTrialBalance(db);
  check(trial.balanced, `el libro no cuadra: debe ${trial.debitCents} y haber ${trial.creditCents}`);
  if (problems.length > 0) throw new SeedReconciliationError(problems);

  return {
    organizations: orgCount,
    initiatives,
    contributions: initiatives.reduce((sum, initiative) => sum + initiative.contributions, 0),
    ticketPasses: await db.ticketPass.count(),
    ledgerDebitCents: trial.debitCents,
    ledgerCreditCents: trial.creditCents,
    journals: await db.ledgerJournal.count()
  };
}
