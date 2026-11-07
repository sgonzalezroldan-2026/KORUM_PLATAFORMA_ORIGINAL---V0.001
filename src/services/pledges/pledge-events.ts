import { chargeDayOf, nextChargeAt } from '@/core/pledges/pledge-rules';
import type { Keyring } from '@/core/security/crypto';
import type { Db } from '@/lib/db';
import { storeCardTokenInTx } from '@/services/payments/card-tokens';
import type { PaymentNotification } from '@/services/payments/payment-provider';
import { PaymentReconciliationError } from '@/services/payments/payment-reversals';

/**
 * Efecto de los cobros de Mi Hucha (`PLEDGE`, Sprint 3.8) sobre su aportación mensual, dentro de la transacción del cobro: o se confirman
 * juntos o no se confirma nada. El dinero sigue el camino de cualquier donación (`payment-events.service.ts`); aquí solo cambia la aportación
 * mensual y se escriben sus avisos.
 */

interface PledgeContribution {
  id: number;
  userId: string | null;
  organizationId: string;
  walletSubscriptionId: number | null;
  pledgeCycle: number | null;
  amountCents: number;
}

type SavedCard = NonNullable<PaymentNotification['card']>;

function requireKeyring(options: { keyring?: () => Keyring }, contributionId: number): Keyring {
  // Sin el llavero no se puede guardar la tarjeta: falla y la notificación se reintenta, en lugar de perderla.
  if (!options.keyring) throw new PaymentReconciliationError(`Cobro de Mi Hucha ${contributionId}: falta el llavero para guardar la tarjeta.`);
  return options.keyring();
}

/**
 * Paycomet ya guardó la tarjeta, pero la aportación no va a cobrar con ella (sustituida, cancelada o con otra viva): se registra **revocada** y
 * enlazada a la aportación cancelada, para que la purga semanal pida borrarla (`retryCardDeletions`). Si no, quedaría guardada en Paycomet sin
 * que KORUM pudiera borrarla nunca (auditoría del Sprint 3.8).
 */
async function keepOnlyForDeletion(tx: Db, subscriptionId: number, userId: string, card: SavedCard, keyring: Keyring, providerName: string, now: Date): Promise<void> {
  const { paymentMethodTokenId } = await storeCardTokenInTx(tx, providerName, { userId, idUser: card.idUser, tokenUser: card.tokenUser, brand: card.brand, revokedAt: now }, keyring);
  await tx.walletSubscription.updateMany({ where: { id: subscriptionId, paymentMethodTokenId: null }, data: { paymentMethodTokenId } });
}

/**
 * Primer pago confirmado: guarda la tarjeta (cifrada, de la familia) y activa la aportación. El día de cobro es el del primer pago. Si Paycomet
 * no devolvió la tarjeta, el primer mes ya es una donación normal, pero la aportación no puede seguir: se cancela y la familia lo ve al volver.
 * Si la aportación ya no está pendiente, o la familia ya tiene otra viva con la entidad, el mes cuenta como donación y la tarjeta solo se guarda
 * para borrarla.
 */
export async function settlePledgePaymentInTx(
  tx: Db,
  contribution: PledgeContribution,
  notification: Pick<PaymentNotification, 'card'>,
  occurredAt: Date,
  options: { keyring?: () => Keyring; cardProvider?: string }
): Promise<void> {
  if (contribution.walletSubscriptionId === null || contribution.pledgeCycle !== 1) return;
  const subscription = await tx.walletSubscription.findUnique({ where: { id: contribution.walletSubscriptionId }, select: { id: true, status: true, userId: true, organizationId: true, totalMonths: true } });
  if (!subscription) return;
  const card = notification.card ?? null;
  const providerName = options.cardProvider ?? 'paycomet';

  if (subscription.status !== 'PENDING') {
    if (card) await keepOnlyForDeletion(tx, subscription.id, subscription.userId, card, requireKeyring(options, contribution.id), providerName, occurredAt);
    return;
  }
  if (!card) {
    await tx.walletSubscription.update({ where: { id: subscription.id }, data: { status: 'CANCELLED', statusReason: 'CARD_NOT_SAVED', statusChangedAt: occurredAt, executedMonths: 1 } });
    return;
  }
  const keyring = requireKeyring(options, contribution.id);
  // Dos altas a la vez con la misma entidad: solo una puede quedar viva (también lo impide un índice único parcial en la base).
  const live = await tx.walletSubscription.findFirst({
    where: { userId: subscription.userId, organizationId: subscription.organizationId, status: { in: ['ACTIVE', 'PAUSED'] }, id: { not: subscription.id } },
    select: { id: true }
  });
  if (live) {
    await tx.walletSubscription.update({ where: { id: subscription.id }, data: { status: 'CANCELLED', statusReason: 'REPLACED', statusChangedAt: occurredAt, executedMonths: 1 } });
    await keepOnlyForDeletion(tx, subscription.id, subscription.userId, card, keyring, providerName, occurredAt);
    return;
  }
  const { paymentMethodTokenId } = await storeCardTokenInTx(tx, providerName, { userId: subscription.userId, idUser: card.idUser, tokenUser: card.tokenUser, brand: card.brand }, keyring);
  const chargeDay = chargeDayOf(occurredAt);
  await tx.walletSubscription.update({
    where: { id: subscription.id },
    data: {
      status: subscription.totalMonths <= 1 ? 'FINISHED' : 'ACTIVE',
      statusReason: null,
      statusChangedAt: occurredAt,
      paymentMethodTokenId,
      executedMonths: 1,
      chargeDay,
      nextChargeAt: nextChargeAt(occurredAt, chargeDay)
    }
  });
}

/**
 * Contracargo de un mes de Mi Hucha: la familia ha reclamado el cobro a su banco, así que no se le vuelve a cobrar con esa tarjeta. La aportación
 * se cancela y la tarjeta se revoca (la purga semanal pide borrarla). El dinero lo deshace `applyChargebackInTx`, como en cualquier cobro.
 */
export async function pledgeChargedBackInTx(tx: Db, walletSubscriptionId: number, now: Date): Promise<void> {
  const subscription = await tx.walletSubscription.findUnique({ where: { id: walletSubscriptionId }, select: { paymentMethodTokenId: true } });
  if (!subscription) return;
  await tx.walletSubscription.updateMany({ where: { id: walletSubscriptionId, status: { in: ['PENDING', 'ACTIVE', 'PAUSED'] } }, data: { status: 'CANCELLED', statusReason: 'CHARGEBACK', statusChangedAt: now } });
  if (subscription.paymentMethodTokenId !== null) await tx.paymentMethodToken.updateMany({ where: { id: subscription.paymentMethodTokenId, revokedAt: null }, data: { revokedAt: now } });
}

/**
 * Un cobro de Mi Hucha que no salió. El primero: la aportación no llega a empezar. Uno de los meses siguientes: se pausa (no se insiste con una
 * tarjeta rechazada) y se avisa a la familia, que decide si la reanuda. Un mes que falla no se reintenta: el siguiente cobro es el del mes que viene.
 */
export async function pledgeChargeFailedInTx(tx: Db, contribution: PledgeContribution, now: Date, reason: 'CHARGE_FAILED' | 'CARD_UNAVAILABLE' = 'CHARGE_FAILED'): Promise<void> {
  if (contribution.walletSubscriptionId === null || contribution.pledgeCycle === null) return;
  if (contribution.pledgeCycle === 1) {
    await tx.walletSubscription.updateMany({ where: { id: contribution.walletSubscriptionId, status: 'PENDING' }, data: { status: 'CANCELLED', statusReason: 'FIRST_PAYMENT_FAILED', statusChangedAt: now } });
    return;
  }
  const { count } = await tx.walletSubscription.updateMany({ where: { id: contribution.walletSubscriptionId, status: 'ACTIVE' }, data: { status: 'PAUSED', statusReason: reason, statusChangedAt: now } });
  // Se avisa si se ha pausado ahora o si era el último mes; nunca a una aportación que la familia ya canceló o pausó.
  if (count === 0) {
    const current = await tx.walletSubscription.findUnique({ where: { id: contribution.walletSubscriptionId }, select: { status: true } });
    if (current?.status !== 'FINISHED') return;
  }
  await queuePledgeNotice(tx, { userId: contribution.userId, organizationId: contribution.organizationId, subscriptionId: contribution.walletSubscriptionId, cycle: contribution.pledgeCycle }, 'pledge.failed', { amountCents: contribution.amountCents, reason });
}

/** Aviso a la familia de su aportación mensual (`pledge.skipped` o `pledge.failed`). Uno por aportación y mes. Nunca a una cuenta suprimida. */
export async function queuePledgeNotice(
  tx: Db,
  target: { userId: string | null; organizationId: string; subscriptionId: number; cycle: number },
  templateKey: 'pledge.skipped' | 'pledge.failed',
  payload: Record<string, string | number | boolean>
): Promise<void> {
  if (!target.userId) return;
  const user = await tx.user.findUnique({ where: { id: target.userId }, select: { email: true, locale: true, gdprAnonymizedAt: true } });
  if (!user || user.gdprAnonymizedAt) return;
  await tx.outboxMessage.createMany({
    data: [
      {
        idempotencyKey: `${templateKey}:${target.subscriptionId}:${target.cycle}`,
        templateKey,
        locale: user.locale,
        toAddress: user.email,
        userId: target.userId,
        organizationId: target.organizationId,
        payloadJson: { ...payload, cycle: target.cycle }
      }
    ],
    skipDuplicates: true
  });
}
