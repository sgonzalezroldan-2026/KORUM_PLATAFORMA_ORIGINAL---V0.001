'use server';

import { z } from 'zod';
import { getEnv } from '@/config/env';
import { getPrisma } from '@/lib/prisma';
import { revertEmailChange, type EmailRevertOutcome } from '@/services/account/email-change-revert.service';

/** «No he sido yo» (Sprint 5.10b): el token llega del fragmento de la URL, que solo lee el navegador. No exige sesión: quien lo tiene controla el email antiguo. */
const tokenSchema = z.string().min(40).max(160);

export async function revertEmailChangeAction(token: unknown): Promise<EmailRevertOutcome> {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) return { status: 'INVALID' };
  return revertEmailChange(getPrisma(), { hmacSecret: getEnv().DATA_HMAC_SECRET }, { token: parsed.data });
}
