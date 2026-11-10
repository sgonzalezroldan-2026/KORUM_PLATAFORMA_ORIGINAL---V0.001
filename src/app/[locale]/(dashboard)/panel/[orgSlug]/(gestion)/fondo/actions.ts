'use server';

import { after } from 'next/server';
import { getEnv } from '@/config/env';
import { buildJobDeps } from '@/core/jobs/job-deps';
import { DoubleCheckNotAllowedError, type DoubleCheckBlock } from '@/core/security/double-check.service';
import { ActivityFundError, type ActivityFundRejection } from '@/core/sponsors/activity-fund-rules';
import { getSessionActor } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { findOrganizationIdBySlug } from '@/repositories/organization.repository';
import { TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { retryFundPayout } from '@/services/payments/activity-fund-payout.service';
import { cancelFundPayout, requestFundPayout, requestFundSignature } from '@/services/sponsors/activity-fund.service';

/**
 * Acciones del Fondo de actividades (Sprint 4.2f). La entidad sale de su `orgSlug` y quien actúa, de la sesión con el segundo factor superado (las
 * acciones no pasan por el `layout`); el servicio comprueba el cargo y que la liquidación sea de esa entidad. El enlace de firma sale al momento desde
 * `after()`, sin esperar a la tarea de la bandeja.
 */

export type FundActionResult =
  | { status: 'OK'; expiresAt?: string; executed?: boolean }
  | { status: 'ERROR'; reason: ActivityFundRejection | DoubleCheckBlock | 'FORBIDDEN' | 'LINK_NOT_SENT' };

async function run(orgSlug: string, operation: (context: { actor: SessionActor; organizationId: string }, db: ReturnType<typeof getPrisma>) => Promise<FundActionResult>): Promise<FundActionResult> {
  const db = getPrisma();
  const organizationId = await findOrganizationIdBySlug(db, orgSlug.slice(0, 64));
  if (!organizationId) return { status: 'ERROR', reason: 'FORBIDDEN' };
  const actor = await getSessionActor();
  if (actor.kind !== 'user' || actor.secondFactor !== true) return { status: 'ERROR', reason: 'FORBIDDEN' };
  try {
    return await operation({ actor, organizationId }, db);
  } catch (error) {
    if (error instanceof ActivityFundError) return { status: 'ERROR', reason: error.reason };
    if (error instanceof DoubleCheckNotAllowedError) return { status: 'ERROR', reason: error.reason };
    if (error instanceof TenantAccessError) return { status: 'ERROR', reason: 'FORBIDDEN' };
    throw error;
  }
}

function dispatchSoon(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getPrisma();
  after(() =>
    dispatchOutbox(db, buildOutboxDeps(db), { ids, limit: ids.length })
      .then(() => undefined)
      .catch((error: unknown) => reportError(error, { stage: 'outbox-after-activity-fund' }))
  );
}

/** Pide la liquidación del Fondo con su destino y envía a quien la pide su enlace de firma. Si el enlace no sale, la liquidación queda pedida igualmente. */
export async function requestFundPayoutAction(orgSlug: string, payload: unknown): Promise<FundActionResult> {
  return run(orgSlug, async ({ actor, organizationId }, db) => {
    try {
      const { receipt } = await requestFundPayout(db, getEnv().DATA_HMAC_SECRET, actor, organizationId, payload);
      if (receipt) dispatchSoon([receipt.notificationId]);
      return { status: 'OK', ...(receipt ? { expiresAt: receipt.expiresAt.toISOString() } : {}) };
    } catch (error) {
      // La liquidación ya existe: si lo que falló es el enlace (límite de peticiones…), se dice, y se puede volver a pedir desde la propia liquidación.
      if (error instanceof DoubleCheckNotAllowedError) return { status: 'ERROR', reason: 'LINK_NOT_SENT' };
      throw error;
    }
  });
}

/** Vuelve a pedir el enlace de firma de la liquidación pendiente (el anterior deja de valer). */
export async function requestFundSignatureAction(orgSlug: string, payload: unknown): Promise<FundActionResult> {
  return run(orgSlug, async ({ actor, organizationId }, db) => {
    const receipt = await requestFundSignature(db, getEnv().DATA_HMAC_SECRET, actor, organizationId, payload);
    dispatchSoon([receipt.notificationId]);
    return { status: 'OK', expiresAt: receipt.expiresAt.toISOString() };
  });
}

/** Retira la liquidación que espera la doble firma: su dinero vuelve a estar disponible y sus enlaces dejan de valer. */
export async function cancelFundPayoutAction(orgSlug: string, payload: unknown): Promise<FundActionResult> {
  return run(orgSlug, async ({ actor, organizationId }, db) => {
    await cancelFundPayout(db, actor, organizationId, payload);
    return { status: 'OK' };
  });
}

/** Reintenta ya el envío de una liquidación firmada que Paycomet no terminó (si no, la tarea diaria lo reintenta sola). */
export async function retryFundPayoutAction(orgSlug: string, payload: unknown): Promise<FundActionResult> {
  return run(orgSlug, async ({ actor, organizationId }, db) => {
    const { status } = await retryFundPayout(db, buildJobDeps(db).paymentProvider, actor, organizationId, payload);
    return { status: 'OK', executed: status === 'EXECUTED' };
  });
}
