'use server';

import { headers } from 'next/headers';
import { getEnv } from '@/config/env';
import { ResizeVoteError, type ResizeVoteChoice, type VoteRejection } from '@/core/resize/resize-rules';
import { getPrisma } from '@/lib/prisma';
import { trustedClientIp } from '@/lib/trusted-ip';
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
