'use server';

import { after } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/config/env';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import type { VerifiedAccountActor } from '@/core/security/verified-actor';
import { getAuthSession, requireVerifiedAccount } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { buildOutboxDeps } from '@/services/email/outbox-deps';
import { dispatchOutbox } from '@/services/email/outbox-processor';
import { submitSupportTicket, type SupportOutcome } from '@/services/support/support-requests.service';

/**
 * Enviar una consulta de soporte (Sprint 3.9). Quien escribe sale de la sesión; la entidad, de su `orgSlug` público. Para pedir la rectificación de
 * datos personales (RGPD art. 16) hace falta haber confirmado la identidad hace menos de 10 minutos: si no, se responde `REAUTH_REQUIRED` y la
 * interfaz pide el código por email y vuelve a llamar. El acuse por email sale al momento, sin esperar a la tarea diaria.
 */

const localeOf = z.object({ locale: z.string().max(10).optional(), topic: z.string().optional() });

export async function submitSupportTicketAction(payload: unknown): Promise<Omit<Extract<SupportOutcome, { status: 'SENT' }>, 'outboxId'> | Extract<SupportOutcome, { status: 'REJECTED' }> | { status: 'LOGIN_REQUIRED' }> {
  const session = await getAuthSession();
  if (!session) return { status: 'LOGIN_REQUIRED' };
  const extra = localeOf.safeParse(payload);
  let actor: VerifiedAccountActor | null = null;
  if (extra.success && extra.data.topic === 'RECTIFICATION') {
    try {
      actor = await requireVerifiedAccount('support.rectification');
    } catch (error) {
      if (!(error instanceof SuperadminRequiredError)) throw error;
    }
  }
  const db = getPrisma();
  const outcome = await submitSupportTicket({ db, hmacSecret: getEnv().DATA_HMAC_SECRET }, { userId: session.userId, payload, actor, locale: extra.success ? (extra.data.locale ?? 'es') : 'es' });
  if (outcome.status !== 'SENT') return outcome;
  const { outboxId, ...result } = outcome;
  after(() => dispatchOutbox(db, buildOutboxDeps(db), { ids: [outboxId], limit: 1 }).then(() => undefined));
  return result;
}
