'use server';

import { getEnv } from '@/config/env';
import { getKeyring } from '@/config/keyring';
import { buildJobDeps } from '@/core/jobs/job-deps';
import { CampaignPayoutError, type CampaignPayoutRejection } from '@/core/payouts/campaign-payout-rules';
import { DoubleCheckNotAllowedError, type DoubleCheckBlock } from '@/core/security/double-check.service';
import { getSessionActor } from '@/lib/auth/session';
import { dispatchOutboxSoon, dispatchPayoutExecutedSoon } from '@/lib/panel/outbox-soon';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { retryCampaignPayout, type PayoutSettlement } from '@/services/payments/campaign-payout-settlement';
import { requestCampaignPayout, requestPayoutSignature } from '@/services/payouts/campaign-payout.service';

/**
 * Acciones de la pantalla de liquidaciones (Sprint 4.4a). La entidad sale de su `orgSlug` y quien actúa, de la sesión con el segundo factor superado (las
 * acciones no pasan por el `layout`); el servicio comprueba el cargo y que la campaña sea de esa entidad. El enlace de firma sale al momento desde
 * `after()`, sin esperar a la tarea de la bandeja.
 */

export type PayoutActionResult =
  | { status: 'OK'; expiresAt?: string; updated?: boolean; settlement?: PayoutSettlement }
  | { status: 'ERROR'; reason: CampaignPayoutRejection | DoubleCheckBlock | 'FORBIDDEN' | 'LINK_NOT_SENT' };

type Db = ReturnType<typeof getPrisma>;

async function run(orgSlug: string, operation: (context: { actor: SessionActor; organizationId: string }, db: Db) => Promise<PayoutActionResult>): Promise<PayoutActionResult> {
  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, orgSlug.slice(0, 64));
  if (!organizationId) return { status: 'ERROR', reason: 'FORBIDDEN' };
  const actor = await getSessionActor();
  if (actor.kind !== 'user' || actor.secondFactor !== true) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    return await operation({ actor, organizationId }, db);
  } catch (error) {
    if (error instanceof CampaignPayoutError) return { status: 'ERROR', reason: error.reason };
    if (error instanceof DoubleCheckNotAllowedError) return { status: 'ERROR', reason: error.reason };
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

/** Pide (o cambia) la liquidación con su destino y su factura, y envía a quien la pide su enlace de firma. Si el enlace no sale, queda pedida igualmente. */
export async function requestPayoutAction(orgSlug: string, payload: unknown): Promise<PayoutActionResult> {
  return run(orgSlug, async ({ actor, organizationId }, db) => {
    try {
      const provider = await buildJobDeps(db).paymentProvider();
      const deps = { secret: getEnv().DATA_HMAC_SECRET, keyring: getKeyring(), providerPayoutAvailable: typeof provider.providerPayoutAccount === 'function' };
      const { receipt, updated } = await requestCampaignPayout(db, deps, actor, organizationId, payload);
      dispatchOutboxSoon(db, [receipt.notificationId], 'outbox-after-campaign-payout');
      return { status: 'OK', expiresAt: receipt.expiresAt.toISOString(), updated };
    } catch (error) {
      // La liquidación ya existe: si lo que falló es el enlace (límite de peticiones…), se dice, y se puede volver a pedir desde la propia liquidación.
      if (error instanceof DoubleCheckNotAllowedError) return { status: 'ERROR', reason: 'LINK_NOT_SENT' };
      throw error;
    }
  });
}

/** Vuelve a pedir el enlace de firma propio de la liquidación pendiente (el anterior deja de valer). */
export async function requestPayoutSignatureAction(orgSlug: string, payload: unknown): Promise<PayoutActionResult> {
  return run(orgSlug, async ({ actor, organizationId }, db) => {
    const receipt = await requestPayoutSignature(db, getEnv().DATA_HMAC_SECRET, actor, organizationId, payload);
    dispatchOutboxSoon(db, [receipt.notificationId], 'outbox-after-campaign-payout');
    return { status: 'OK', expiresAt: receipt.expiresAt.toISOString() };
  });
}

/** Reintenta ya una liquidación con las dos firmas que no se pudo aprobar o enviar (si no, la tarea diaria lo reintenta sola). */
export async function retryPayoutAction(orgSlug: string, payload: unknown): Promise<PayoutActionResult> {
  return run(orgSlug, async ({ actor, organizationId }, db) => {
    const { payoutId, ...settlement } = await retryCampaignPayout(db, buildJobDeps(db).paymentProvider, { secret: getEnv().DATA_HMAC_SECRET, keyring: getKeyring() }, actor, organizationId, payload);
    if (settlement.status === 'EXECUTED') await dispatchPayoutExecutedSoon(db, payoutId);
    return { status: 'OK', settlement };
  });
}
