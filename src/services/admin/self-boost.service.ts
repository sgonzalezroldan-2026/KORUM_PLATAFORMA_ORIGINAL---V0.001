import { spanishFiscalYear } from '@/core/checkout/checkout-rules';
import { postJournal } from '@/core/finance/ledger.service';
import { selfBoostLines } from '@/core/finance/payment-journals';
import { fixHasEffect, missingToGoal, planNegativeReturnFix, SELF_BOOST_AUTH_CODE, selfBoostOrder, selfBoostRejection, SelfBoostNotAllowedError, type NegativeReturnFixPlan } from '@/core/finance/self-boost';
import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { inTransaction, type Db } from '@/lib/db';
import { markGoalReached } from '@/services/payments/goal-reached';
import { loadBiSnapshot } from './bi-snapshot';
import { hasTicketingOnSale } from './org-admin.service';

/**
 * Acciones del pop-up ejecutivo de una iniciativa (Sprint 5.2): el Auto-Impulso y la corrección de tarifas. Las dos exigen el Super-Admin verificado
 * (TOTP de hace menos de 10 minutos) y se repiten sin efecto si ya no procede: ninguna gasta más de lo que la persona vio en pantalla.
 */

export interface SelfBoostResult {
  contributionId: number;
  amountCents: number;
  publiclyDisclosed: boolean;
}

export interface SelfBoostInput {
  initiativeId: number;
  /** Lo que faltaba para la meta cuando la persona abrió la ficha: si cambió (otra aportación), no se ejecuta. */
  expectedAmountCents: number;
  /** Decisión de esta ejecución: si la ficha dice, sin importe, que la plataforma también aportó («La plataforma KORUM también aportó y ayudó a conseguir el reto»). */
  publiclyDisclosed: boolean;
  /**
   * Aportar aunque a KORUM no le compense (el retorno tras aportar es negativo o la campaña no cumple el 💎). Hay que pedirlo expresamente y queda en la auditoría:
   * el servidor recalcula la rentabilidad, no se fía de lo que la pantalla enseñó.
   */
  acceptLoss?: boolean;
}

/**
 * Aporta lo que falta para la meta con dinero de KORUM y la completa. Todo en una transacción con la fila de la iniciativa bloqueada: el asiento
 * (`AUTO_BOOST_EXPENSE` → `INITIATIVE_ESCROW`), la aportación `SELF_BOOST` (cuenta como `💛`, no como curso), `raisedCents`, el paso a `GOAL_REACHED`
 * con sus avisos y la auditoría se confirman juntos o no se confirma nada. Un doble clic o dos personas a la vez: solo pasa una.
 */
export async function executeSelfBoost(db: Db, actor: VerifiedSuperadminActor, input: SelfBoostInput, now: Date = new Date()): Promise<SelfBoostResult> {
  assertVerifiedSuperadmin(actor, 'selfboost.execute', now);
  // La rentabilidad se recalcula en el servidor, con las mismas cifras que la tabla, antes de abrir la transacción (el BI lee mucho). Lo que falta exactamente se
  // vuelve a comprobar dentro, con la fila bloqueada.
  const biRow = (await loadBiSnapshot(db, {})).initiatives.find((row) => row.id === input.initiativeId);
  const profitable = biRow?.isProfitableSelfBoost ?? false;
  // Una campaña con 🚨 se corrige por sus precios: la pantalla no ofrece el Auto-Impulso y el servidor tampoco lo ejecuta aunque llegue `acceptLoss`.
  if (biRow?.isNegativeReturnAlert) throw new SelfBoostNotAllowedError(input.initiativeId, 'NEGATIVE_RETURN', 'tiene retorno negativo y se corrige por sus precios');
  return inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'selfboost.execute', now);
    // Bloquea la iniciativa antes de leer nada: un cobro, una devolución o este mismo botón a la vez se ordenan.
    const locked = await tx.initiative.updateMany({ where: { id: input.initiativeId, status: 'FUNDRAISING' }, data: { updatedAt: now } });
    const initiative = await tx.initiative.findUnique({ where: { id: input.initiativeId }, select: { organizationId: true, status: true, goalCents: true, raisedCents: true, closesAt: true, walletEscrowId: true, organization: { select: { archivedAt: true } } } });
    if (!initiative) throw new SelfBoostNotAllowedError(input.initiativeId, 'NOT_FOUND', 'no existe');
    if (initiative.organization.archivedAt !== null) throw new SelfBoostNotAllowedError(input.initiativeId, 'ORG_ARCHIVED', 'la entidad está archivada');
    if (locked.count === 0) throw new SelfBoostNotAllowedError(input.initiativeId, 'NOT_FUNDRAISING', `está en estado ${initiative.status}`);
    const rejection = selfBoostRejection(initiative, input.expectedAmountCents, now);
    if (rejection !== null) throw new SelfBoostNotAllowedError(input.initiativeId, rejection, rejection === 'AMOUNT_CHANGED' ? `lo que falta ya no es ${input.expectedAmountCents} céntimos` : rejection);

    if (!profitable && input.acceptLoss !== true) throw new SelfBoostNotAllowedError(input.initiativeId, 'NOT_PROFITABLE', 'a KORUM no le compensa y no se aceptó la pérdida');
    const amountCents = missingToGoal(initiative.goalCents, initiative.raisedCents);
    // Una campaña que un contracargo devolvió a recaudar puede necesitar otro Auto-Impulso: cada uno lleva su número.
    const sequence = (await tx.contribution.count({ where: { initiativeId: input.initiativeId, type: 'SELF_BOOST' } })) + 1;
    const order = selfBoostOrder(input.initiativeId, sequence);
    const contribution = await tx.contribution.create({
      data: {
        organizationId: initiative.organizationId,
        initiativeId: input.initiativeId,
        fiscalYear: spanishFiscalYear(now),
        type: 'SELF_BOOST',
        amountCents,
        // Origen del reparto de la liquidación (ver `self-boost.ts`): es dinero de KORUM, no una compra de nadie.
        totalChargedCents: amountCents,
        publiclyDisclosed: input.publiclyDisclosed,
        paymentMethod: 'PLATFORM',
        paycometOrder: order,
        paycometAuthCode: SELF_BOOST_AUTH_CODE,
        status: 'COMPLETED',
        createdAt: now
      },
      select: { id: true }
    });
    const scope = { organizationId: initiative.organizationId, initiativeId: input.initiativeId };
    await postJournal(tx, {
      ...scope,
      idempotencyKey: `selfboost:${order}`,
      kind: 'SELF_BOOST_INJECTION',
      description: `Auto-Impulso de KORUM a ${initiative.walletEscrowId}`,
      contributionId: contribution.id,
      paycometReference: order,
      occurredAt: now,
      createdById: actor.userId,
      lines: selfBoostLines(scope, amountCents)
    });
    // Suma al contador 💛 como cualquier otra aportación (decisión del promotor, 2026-11-12), pero no a ningún curso: KORUM no pertenece a ninguno (Regla 02 §7).
    await tx.initiative.update({ where: { id: input.initiativeId }, data: { raisedCents: { increment: amountCents }, totalContributions: { increment: 1 } } });
    await markGoalReached(tx, initiative.organizationId, input.initiativeId, now);
    await tx.auditLog.create({
      data: {
        actorType: 'USER',
        actorUserId: actor.userId,
        organizationId: initiative.organizationId,
        action: 'selfboost.executed',
        targetType: 'Initiative',
        targetId: String(input.initiativeId),
        metadataJson: { contributionId: contribution.id, amountCents, publiclyDisclosed: input.publiclyDisclosed, order, profitable, lossAccepted: !profitable }
      }
    });
    return { contributionId: contribution.id, amountCents, publiclyDisclosed: input.publiclyDisclosed };
  });
}

export class TariffFixNotNeededError extends Error {
  constructor(readonly initiativeId: number) {
    super(`La iniciativa ${initiativeId} no tiene tarifas que corregir sin tocar lo ya prometido.`);
    this.name = 'TariffFixNotNeededError';
  }
}

/** Qué cambiaría el botón para esta iniciativa, sin cambiar nada (lo usa la ficha para ofrecerlo o explicar por qué no). */
export async function previewNegativeReturnFix(db: Db, initiativeId: number): Promise<NegativeReturnFixPlan | null> {
  const initiative = await db.initiative.findUnique({
    where: { id: initiativeId },
    select: { status: true, absorbsGatewayCostByKorum: true, organizationId: true, organization: { select: { customRules: true, fullIntegrityCheckCents: true, ticketFeeFixedCents: true, ticketFeeBps: true } } }
  });
  if (!initiative) return null;
  const hasPublishedTicketing = await hasTicketingOnSale(db, initiative.organizationId, new Date());
  const global = await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { fullIntegrityCheckCents: true, ticketFeeFixedCents: true, ticketFeeBps: true } });
  return planNegativeReturnFix(initiative, { ...initiative.organization, hasPublishedTicketing }, global);
}

/**
 * Corrige el retorno negativo en 1 clic, solo con lo que no se había prometido (decisión del promotor, 2026-11-11): sube a los valores globales las
 * tarifas propias de la entidad que están por debajo (para sus próximas campañas).
 * Una campaña ya publicada no se toca. Lo que cambia queda en la auditoría con su antes y su después.
 */
export async function fixNegativeReturnTariff(db: Db, actor: VerifiedSuperadminActor, initiativeId: number, now: Date = new Date()): Promise<NegativeReturnFixPlan> {
  assertVerifiedSuperadmin(actor, 'tariff.fix_negative_return', now);
  // Solo una iniciativa con retorno negativo (🚨) cuyo negativo NO se explica por lo ya gastado (Auto-Impulso, contracargos) tiene algo que corregir: subir las
  // tarifas no arregla un gasto ya hecho, y la pantalla tampoco ofrece el botón en ese caso (auditoría financiera del 5.2, H1).
  const row = (await loadBiSnapshot(db, {})).initiatives.find((candidate) => candidate.id === initiativeId);
  if (!row?.isNegativeReturnAlert || row.netRevenueCents + row.sunkCostsCents >= 0) throw new TariffFixNotNeededError(initiativeId);
  return inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'tariff.fix_negative_return', now);
    const initiative = await tx.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true } });
    if (!initiative) throw new TariffFixNotNeededError(initiativeId);
    // Las dos filas se bloquean antes de decidir, en el mismo orden que el resto (iniciativa y luego entidad).
    await tx.initiative.updateMany({ where: { id: initiativeId }, data: { updatedAt: now } });
    await tx.organization.updateMany({ where: { id: initiative.organizationId }, data: { updatedAt: now } });
    const plan = await previewNegativeReturnFix(tx, initiativeId);
    if (!plan || !fixHasEffect(plan)) throw new TariffFixNotNeededError(initiativeId);
    const before = await tx.organization.findUniqueOrThrow({ where: { id: initiative.organizationId }, select: { fullIntegrityCheckCents: true, ticketFeeFixedCents: true, ticketFeeBps: true } });
    if (Object.keys(plan.organization).length > 0) await tx.organization.update({ where: { id: initiative.organizationId }, data: plan.organization });
    await tx.auditLog.create({
      data: {
        actorType: 'USER',
        actorUserId: actor.userId,
        organizationId: initiative.organizationId,
        action: 'tariff.negative_return_fixed',
        targetType: 'Initiative',
        targetId: String(initiativeId),
        metadataJson: { organizationBefore: before, organizationChanges: plan.organization, publishedLeftUntouched: plan.publishedLeftUntouched }
      }
    });
    return plan;
  });
}
