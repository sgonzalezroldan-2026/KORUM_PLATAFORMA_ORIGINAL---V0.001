'use server';

import { headers } from 'next/headers';
import { after } from 'next/server';
import { getEnv } from '@/config/env';
import { ResizeVoteError, type ResizeVoteChoice, type VoteRejection } from '@/core/resize/resize-rules';
import { getPrisma } from '@/lib/prisma';
import { trustedClientIp } from '@/lib/trusted-ip';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { queueResendLinks, reserveResendAttempt } from '@/services/resize/resize-link-resend.service';
import { castResizeVote } from '@/services/resize/resize-vote.service';

/**
 * Voto de redimensionamiento desde el enlace personal del email (Sprint 4.4b). Quién vota y en qué votación salen del enlace firmado y de la base, nunca de
 * lo que envía el navegador (que solo elige una opción o la devolución). Con límite de intentos por red.
 */

export type ResizeVoteResult = { status: 'OK'; choice: ResizeVoteChoice; refundedCents: number } | { status: 'ERROR'; reason: VoteRejection | 'FAILED' };

export async function castResizeVoteAction(payload: unknown): Promise<ResizeVoteResult> {
  const requestHeaders = await headers();
  const ip = trustedClientIp((name) => requestHeaders.get(name));
  try {
    const receipt = await castResizeVote(getPrisma(), getEnv().DATA_HMAC_SECRET, payload, { ip });
    return { status: 'OK', choice: receipt.choice, refundedCents: receipt.refundedCents };
  } catch (error) {
    if (error instanceof ResizeVoteError) return { status: 'ERROR', reason: error.reason };
    throw error;
  }
}

export type ResendVoteLinkResult = { status: 'ACCEPTED' } | { status: 'ERROR'; reason: 'INVALID_EMAIL' | 'RATE_LIMITED' };

/**
 * «Reenviarme mi enlace de voto» (Sprint 5.5b). La respuesta no dice si el email donó, ni con su texto ni con su tiempo: aquí solo se valida y se reservan los topes;
 * buscar la donación, escribir el enlace en la bandeja y enviarlo va en `after()`, con la respuesta ya enviada (auditoría de seguridad del 5.5b, H1).
 */
export async function resendVoteLinkAction(payload: unknown): Promise<ResendVoteLinkResult> {
  const requestHeaders = await headers();
  const ip = trustedClientIp((name) => requestHeaders.get(name));
  const db = getPrisma();
  const secret = getEnv().DATA_HMAC_SECRET;
  const attempt = await reserveResendAttempt(db, secret, payload, { ip });
  if (attempt.status !== 'ACCEPTED') return { status: 'ERROR', reason: attempt.status };
  after(async () => {
    const ids = await queueResendLinks(db, secret, attempt.request);
    if (ids.length > 0) await dispatchOutbox(db, buildOutboxDeps(db), { ids, limit: ids.length });
  });
  return { status: 'ACCEPTED' };
}
