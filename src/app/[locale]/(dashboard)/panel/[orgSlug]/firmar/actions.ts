'use server';

import { after } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/config/env';
import { completeSignature, type DoubleCheckBlock } from '@/core/security/double-check.service';
import { previewChallenge } from '@/core/security/double-check-preview';
import { getSessionActor } from '@/lib/auth/session';
import { reportError } from '@/lib/error-reporting';
import { getPrisma } from '@/lib/prisma';
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
  | { status: 'READY'; targetType: 'ESCROW_PAYOUT'; expiresAt: string; payout: { initiativeTitle: string; walletEscrowId: string; netPaidCents: number; destinationType: 'ORGANIZATION' | 'PROVIDER' } }
  | { status: 'INVALID_LINK' | 'LOGIN_REQUIRED' | 'TWO_FACTOR_REQUIRED' };

export type SignResult =
  | { status: 'SIGNED'; complete: boolean; initiativeId: number | null; otherSignerNotified: boolean }
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
  return preview.targetType === 'IDEA_APPROVAL' ? { status: 'READY', targetType: 'IDEA_APPROVAL', expiresAt, idea: preview.idea } : { status: 'READY', targetType: 'ESCROW_PAYOUT', expiresAt, payout: preview.payout };
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
  return { status: 'SIGNED', complete: result.complete, initiativeId: result.initiativeId, otherSignerNotified: ids.length > 0 };
}
