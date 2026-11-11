'use server';

import { after } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/config/env';
import { buildJobDeps } from '@/core/jobs/job-deps';
import { completeSignature, type DoubleCheckBlock } from '@/core/security/double-check.service';
import { previewChallenge } from '@/core/security/double-check-preview';
import { getSessionActor } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
import { getKeyring } from '@/config/keyring';
import { dispatchPayoutExecutedSoon } from '@/lib/panel/outbox-soon';
import { settleSignedFundPayout, type FundSettlement } from '@/services/payments/activity-fund-payout.service';
import { settleSignedCampaignPayout, type PayoutSettlement } from '@/services/payments/campaign-payout-settlement';
import type { SessionActor } from '@/repositories/tenant-guard';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';

/**
 * Firma con el enlace de un solo uso y el código de 6 dígitos (Sprint 4.2a, heredado del 2.6). El token llega del fragmento `#t=` que el
 * navegador nunca envía al servidor por sí solo: la página lo lee, lo borra de la barra y lo manda aquí. Quién firma sale de la sesión, que debe
 * haber superado el segundo factor; `completeSignature` comprueba además que el enlace es de esa persona y vuelve a validar cargo y firmas.
 */

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/);
const signSchema = z.object({ token: tokenSchema, otp: z.string().regex(/^\d{6}$/) });

export type PreviewResult =
  | { status: 'READY'; targetType: 'IDEA_APPROVAL'; expiresAt: string; idea: { alias: string; title: string; category: string; description: string; verifiedVotes: number; revalidatedVotes: number } }
  | {
      status: 'READY';
      targetType: 'ESCROW_PAYOUT';
      expiresAt: string;
      payout: {
        initiativeTitle: string;
        walletEscrowId: string;
        netPaidCents: number;
        destinationType: 'ORGANIZATION' | 'PROVIDER';
        beneficiaryName: string;
        ibanBank: string | null;
        ibanLast4: string | null;
        invoiceFileId: string | null;
        requestedBy: { name: string; at: string } | null;
      };
    }
  | { status: 'READY'; targetType: 'ACTIVITY_FUND_PAYOUT'; expiresAt: string; fund: { reference: string; amountCents: number; purpose: string; sponsors: number } }
  | { status: 'INVALID_LINK' | 'LOGIN_REQUIRED' | 'TWO_FACTOR_REQUIRED' };

export type SignResult =
  | {
      status: 'SIGNED';
      complete: boolean;
      initiativeId: number | null;
      otherSignerNotified: boolean;
      /** Liquidación del Fondo de actividades: a dónde vuelve quien firma y, con las dos firmas, qué ha pasado con el envío a la entidad. */
      fund: { settlement: FundSettlement | null } | null;
      /** Liquidación de una campaña (Sprint 4.4a): con las dos firmas, qué ha pasado con el envío (`null` si no se pudo saber: la tarea lo reanuda). */
      payout: { settlement: PayoutSettlement | null } | null;
    }
  | { status: 'INVALID_OTP'; attemptsLeft: number }
  | { status: 'INVALID_LINK' | 'INVALID_INPUT' | 'TARGET_CHANGED' | 'LOGIN_REQUIRED' | 'TWO_FACTOR_REQUIRED' }
  | { status: 'NOT_ALLOWED'; reason: DoubleCheckBlock };

type SignerSession = { ok: true; actor: Extract<SessionActor, { kind: 'user' }> } | { ok: false; error: 'LOGIN_REQUIRED' | 'TWO_FACTOR_REQUIRED' };

async function signerActor(): Promise<SignerSession> {
  const actor = await getSessionActor();
  if (actor.kind !== 'user') return { ok: false, error: 'LOGIN_REQUIRED' };
  if (actor.secondFactor !== true) return { ok: false, error: 'TWO_FACTOR_REQUIRED' };
  return { ok: true, actor };
}

export async function previewSignatureAction(orgSlug: string, token: unknown): Promise<PreviewResult> {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) return { status: 'INVALID_LINK' };
  const session = await signerActor();
  if (!session.ok) return { status: session.error };
  const preview = await previewChallenge(getPrisma(), getEnv().DATA_HMAC_SECRET, session.actor, { token: parsed.data, organizationSlug: orgSlug.slice(0, 64) });
  if (preview.status !== 'READY') return preview;
  const expiresAt = preview.expiresAt.toISOString();
  if (preview.targetType === 'IDEA_APPROVAL') return { status: 'READY', targetType: 'IDEA_APPROVAL', expiresAt, idea: preview.idea };
  if (preview.targetType === 'ACTIVITY_FUND_PAYOUT') return { status: 'READY', targetType: 'ACTIVITY_FUND_PAYOUT', expiresAt, fund: preview.fund };
  const { requestedBy, ...payout } = preview.payout;
  return { status: 'READY', targetType: 'ESCROW_PAYOUT', expiresAt, payout: { ...payout, requestedBy: requestedBy ? { name: requestedBy.name, at: requestedBy.at.toISOString() } : null } };
}

export async function completeSignatureAction(payload: unknown): Promise<SignResult> {
  const parsed = signSchema.safeParse(payload);
  if (!parsed.success) return { status: tokenSchema.safeParse((payload as { token?: unknown } | null)?.token).success ? 'INVALID_INPUT' : 'INVALID_LINK' };
  const session = await signerActor();
  if (!session.ok) return { status: session.error };
  const db = getPrisma();
  const result = await completeSignature(db, getEnv().DATA_HMAC_SECRET, session.actor, { ...parsed.data, signerIpHash: session.actor.requestMeta?.ipHash });
  if (result.status !== 'SIGNED') return result;
  // El enlace para la otra persona sale ya, sin esperar a la tarea de la bandeja de salida.
  const ids = result.nextChallenges.map((receipt) => receipt.notificationId);
  if (ids.length > 0) {
    after(() =>
      dispatchOutbox(db, buildOutboxDeps(db), { ids, limit: ids.length })
        .then(() => undefined)
        .catch((error: unknown) => reportError(error, { stage: 'outbox-after-signature' }))
    );
  }
  const fund = result.target.targetType === 'ACTIVITY_FUND_PAYOUT' ? { settlement: result.complete ? await settleFund(db, result.target.fundPayoutId) : null } : null;
  if (result.target.targetType === 'ACTIVITY_FUND_PAYOUT' && fund?.settlement?.status === 'EXECUTED') {
    // «Fondo liquidado» a las dos personas, al momento (no con la tarea de la bandeja).
    const paid = await db.outboxMessage.findMany({ where: { templateKey: 'activityFund.paid', status: 'PENDING', idempotencyKey: { startsWith: `activityFund.paid:payout:${result.target.fundPayoutId}:` } }, select: { id: true }, take: 4 });
    const paidIds = paid.map((row) => row.id);
    if (paidIds.length > 0) {
      after(() =>
        dispatchOutbox(db, buildOutboxDeps(db), { ids: paidIds, limit: paidIds.length })
          .then(() => undefined)
          .catch((error: unknown) => reportError(error, { stage: 'outbox-after-fund-payout' }))
      );
    }
  }
  const payout = result.target.targetType === 'ESCROW_PAYOUT' ? { settlement: result.complete ? await settleCampaign(db, result.target.payoutId) : null } : null;
  if (result.target.targetType === 'ESCROW_PAYOUT' && payout?.settlement?.status === 'EXECUTED') await dispatchPayoutExecutedSoon(db, result.target.payoutId);
  return { status: 'SIGNED', complete: result.complete, initiativeId: result.initiativeId, otherSignerNotified: ids.length > 0, fund, payout };
}

/**
 * Segunda firma de la liquidación de una campaña (Sprint 4.4a, heredado de los 2.2 y 4.2a): se aprueba y se envía en el acto. Si Paycomet falla, la firma ya
 * cuenta y la tarea diaria lo reanuda: quien firma ve el estado, no un error.
 */
async function settleCampaign(db: ReturnType<typeof getPrisma>, payoutId: number): Promise<PayoutSettlement | null> {
  try {
    return await settleSignedCampaignPayout(db, buildJobDeps(db).paymentProvider, payoutId, { secret: getEnv().DATA_HMAC_SECRET, keyring: getKeyring() });
  } catch (error) {
    reportError(error, { stage: 'campaign-payout-settle', payoutId });
    return null;
  }
}

/**
 * Segunda firma de una liquidación del Fondo de actividades (Sprint 4.2f): se aprueba y se envía a la cuenta de la entidad en el acto. Si Paycomet falla,
 * la firma ya cuenta y la tarea diaria lo reanuda: quien firma ve el estado, no un error.
 */
async function settleFund(db: ReturnType<typeof getPrisma>, payoutId: number): Promise<FundSettlement | null> {
  try {
    return await settleSignedFundPayout(db, buildJobDeps(db).paymentProvider, payoutId, getEnv().DATA_HMAC_SECRET);
  } catch (error) {
    reportError(error, { stage: 'activity-fund-settle', payoutId });
    return null;
  }
}
