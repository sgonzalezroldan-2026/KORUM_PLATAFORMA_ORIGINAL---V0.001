import { spanishFiscalYear } from '@/core/checkout/checkout-rules';
import { newPledgeOrder, nextChargeAt, pickPledgeCampaign } from '@/core/pledges/pledge-rules';
import type { Keyring } from '@/core/security/crypto';
import { DecryptionError } from '@/core/security/crypto';
import { inTransaction, type Db } from '@/lib/db';
import { loadCardToken } from '@/services/payments/card-tokens';
import { applyPaymentNotification } from '@/services/payments/payment-events.service';
import { PaymentProviderError, type PaymentProvider } from '@/services/payments/payment-provider';
import { loadLockedContribution } from '@/services/payments/payment-reversals';
import { pledgeChargeFailedInTx, queuePledgeNotice } from './pledge-events';
import { openPledgeCampaigns, retirePledgeCard } from './pledge.service';

/**
 * Cobro de un mes de Mi Hucha (`MONTHLY_TOPUP`, skill de pagos §7). En dos tiempos, para no llamar a Paycomet dentro de una transacción:
 *
 * 1. **Reserva del mes** (transacción): avanza la aportación al mes siguiente solo si sigue vencida, así que dos ejecuciones a la vez nunca
 *    cobran el mismo mes; y el índice único `(walletSubscriptionId, pledgeCycle)` lo garantiza también en la base. Si la entidad no tiene ninguna
 *    campaña recaudando, ese mes no se cobra y se avisa. Si no, deja la donación `PENDING` del mes.
 * 2. **Cobro** con la tarjeta guardada. Con el código de autorización se asienta en el acto por el mismo camino que la notificación de Paycomet
 *    (que, al llegar después, ya no hace nada). Un rechazo deja la donación fallida y pausa la aportación. Un resultado desconocido no se repite:
 *    la donación queda `PENDING` hasta que llegue la notificación (o lo mire una persona, con la alerta `MONTHLY_TOPUP_DUE`).
 */

export type PledgeCycleOutcome = 'CHARGED' | 'SKIPPED' | 'FAILED' | 'UNKNOWN' | 'NOT_DUE';

/** Todo se resuelve **antes** de reservar ningún mes: una configuración rota hace fallar la tarea sin dejar meses reservados y sin cobrar. */
export interface PledgeBillingDeps {
  db: Db;
  provider: PaymentProvider;
  keyring: Keyring;
  /** IP que se envía a Paycomet: sin la persona delante, la del servidor (ajuste `paycomet.serverIp`). */
  originalIp: string;
}

const cardDeps = (deps: PledgeBillingDeps) => ({ db: deps.db, keyring: deps.keyring, paymentProvider: () => Promise.resolve(deps.provider) });

type Claim =
  | { kind: 'NOT_DUE' }
  | { kind: 'SKIPPED'; finished: boolean; tokenId: number | null }
  | { kind: 'CARD_GONE'; contributionId: number }
  | { kind: 'CHARGE'; contributionId: number; order: string; totalCents: number; tokenId: number; userId: string; finished: boolean };

async function claimCycle(tx: Db, pledgeId: number, now: Date): Promise<Claim> {
  const pledge = await tx.walletSubscription.findUnique({
    where: { id: pledgeId },
    select: {
      userId: true,
      organizationId: true,
      initiativeId: true,
      monthlyAmountCents: true,
      feePerMonthCents: true,
      totalMonths: true,
      executedMonths: true,
      skippedMonths: true,
      chargeDay: true,
      paymentMethodTokenId: true,
      user: { select: { email: true, canonicalEmail: true, locale: true, gdprAnonymizedAt: true } },
      paymentMethodToken: { select: { revokedAt: true } }
    }
  });
  if (!pledge?.organizationId) return { kind: 'NOT_DUE' };
  const cycle = pledge.executedMonths + 1;
  const finished = cycle >= pledge.totalMonths;
  // La reserva: solo quien la gana sigue. Con la fila bloqueada hasta confirmar, una segunda ejecución ve el mes ya avanzado.
  const { count } = await tx.walletSubscription.updateMany({
    where: { id: pledgeId, status: 'ACTIVE', nextChargeAt: { lte: now }, executedMonths: pledge.executedMonths },
    data: { executedMonths: cycle, nextChargeAt: nextChargeAt(now, pledge.chargeDay), ...(finished ? { status: 'FINISHED', statusChangedAt: now } : {}) }
  });
  if (count === 0) return { kind: 'NOT_DUE' };

  const open = await tx.initiative.findMany({ where: { organizationId: pledge.organizationId, ...openPledgeCampaigns(now), organization: { archivedAt: null } }, select: { id: true, closesAt: true } });
  const campaign = pickPledgeCampaign(open, pledge.initiativeId, now);
  if (!campaign) {
    await tx.walletSubscription.update({ where: { id: pledgeId }, data: { skippedMonths: pledge.skippedMonths + 1 } });
    await queuePledgeNotice(tx, { userId: pledge.userId, organizationId: pledge.organizationId, subscriptionId: pledgeId, cycle }, 'pledge.skipped', { amountCents: pledge.monthlyAmountCents, totalMonths: pledge.totalMonths, last: finished });
    return { kind: 'SKIPPED', finished, tokenId: pledge.paymentMethodTokenId };
  }

  // El NIF de cada mes es el del primer pago (ya cifrado y mantenido por la rotación de claves): la aportación mensual no guarda otro.
  const first = await tx.contribution.findUnique({
    where: { walletSubscriptionId_pledgeCycle: { walletSubscriptionId: pledgeId, pledgeCycle: 1 } },
    select: { donorTaxIdEnc: true, donorTaxIdHmac: true, donorTaxIdKeyVersion: true, donorFullName: true, donorProvinceCode: true, isTaxDeductible: true }
  });
  const order = newPledgeOrder();
  const totalCents = pledge.monthlyAmountCents + pledge.feePerMonthCents;
  const contribution = await tx.contribution.create({
    data: {
      organizationId: pledge.organizationId,
      initiativeId: campaign.id,
      userId: pledge.userId,
      canonicalEmail: pledge.user.gdprAnonymizedAt ? null : pledge.user.canonicalEmail,
      ...(first ?? {}),
      locale: pledge.user.locale,
      fiscalYear: spanishFiscalYear(now),
      type: 'DONATION',
      amountCents: pledge.monthlyAmountCents,
      totalChargedCents: totalCents,
      paymentMethod: 'CARD',
      paycometOrder: order,
      status: 'PENDING',
      walletSubscriptionId: pledgeId,
      pledgeCycle: cycle,
      createdAt: now
    },
    select: { id: true }
  });
  if (pledge.user.gdprAnonymizedAt || !pledge.paymentMethodTokenId || pledge.paymentMethodToken?.revokedAt) return { kind: 'CARD_GONE', contributionId: contribution.id };
  return { kind: 'CHARGE', contributionId: contribution.id, order, totalCents, tokenId: pledge.paymentMethodTokenId, userId: pledge.userId, finished };
}

/** Deja el mes como fallido y pausa la aportación (o la cancela si la cuenta ya no existe), en una transacción con la iniciativa bloqueada. */
async function failCycle(db: Db, contributionId: number, now: Date, reason: 'CHARGE_FAILED' | 'CARD_UNAVAILABLE'): Promise<void> {
  await inTransaction(db, async (tx) => {
    const contribution = await loadLockedContribution(tx, { id: contributionId });
    if (!contribution) return;
    const { count } = await tx.contribution.updateMany({ where: { id: contributionId, status: 'PENDING' }, data: { status: 'FAILED' } });
    if (count === 1) await pledgeChargeFailedInTx(tx, contribution, now, reason);
  });
}

export async function chargePledgeCycle(deps: PledgeBillingDeps, pledgeId: number, now: Date = new Date()): Promise<PledgeCycleOutcome> {
  const claim = await inTransaction(deps.db, (tx) => claimCycle(tx, pledgeId, now));
  if (claim.kind === 'NOT_DUE') return 'NOT_DUE';
  if (claim.kind === 'SKIPPED') {
    if (claim.finished && claim.tokenId !== null) await retirePledgeCard(cardDeps(deps), claim.tokenId, now);
    return 'SKIPPED';
  }
  if (claim.kind === 'CARD_GONE') {
    await failCycle(deps.db, claim.contributionId, now, 'CARD_UNAVAILABLE');
    return 'FAILED';
  }

  let card: { idUser: number; tokenUser: string };
  try {
    card = await loadCardToken(deps.db, claim.tokenId, { userId: claim.userId }, deps.keyring);
  } catch (error) {
    if (!(error instanceof DecryptionError) && !(error instanceof RangeError)) throw error;
    await failCycle(deps.db, claim.contributionId, now, 'CARD_UNAVAILABLE');
    return 'FAILED';
  }

  // La familia pudo cancelar o pausar entre la reserva del mes y este momento: si es así, no se cobra.
  const current = await deps.db.walletSubscription.findUnique({ where: { id: pledgeId }, select: { status: true } });
  if (current?.status !== 'ACTIVE' && current?.status !== 'FINISHED') {
    await failCycle(deps.db, claim.contributionId, now, 'CHARGE_FAILED');
    return 'FAILED';
  }

  let outcome: PledgeCycleOutcome;
  try {
    const result = await deps.provider.charge({ order: claim.order, amountCents: claim.totalCents, method: 'CARD', originalIp: deps.originalIp, card, merchantInitiated: true });
    if (result.authCode && !result.challengeUrl) {
      const authCode = result.authCode;
      await inTransaction(deps.db, (tx) =>
        applyPaymentNotification(tx, { externalEventId: `charge:${claim.order}`, kind: 'PAYMENT_COMPLETED', order: claim.order, amountCents: claim.totalCents, currency: 'EUR', authCode, occurredAt: now, payload: {} }, now)
      );
      outcome = 'CHARGED';
    } else {
      // Paycomet pide que la persona se autentique: sin ella delante no se puede. Se trata como un rechazo y la familia decide.
      await failCycle(deps.db, claim.contributionId, now, 'CHARGE_FAILED');
      outcome = 'FAILED';
    }
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error;
    if (error.outcomeUnknown) {
      // El mes queda pendiente de confirmar; si era el último, la tarjeta ya no hace falta (devolver no la necesita: usa el pedido).
      if (claim.finished) await retirePledgeCard(cardDeps(deps), claim.tokenId, now);
      return 'UNKNOWN';
    }
    await failCycle(deps.db, claim.contributionId, now, 'CHARGE_FAILED');
    outcome = 'FAILED';
  }
  // El último mes cobrado (o intentado) termina la aportación: la tarjeta ya no hace falta.
  if (claim.finished) await retirePledgeCard(cardDeps(deps), claim.tokenId, now);
  return outcome;
}
