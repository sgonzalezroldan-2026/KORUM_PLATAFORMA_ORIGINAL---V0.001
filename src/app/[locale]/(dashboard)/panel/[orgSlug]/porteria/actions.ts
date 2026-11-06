'use server';

import { z } from 'zod';
import { getEnv } from '@/config/env';
import { closeGateSessionByToken, openGateSession } from '@/core/ticketing/gate-session.service';
import { currentRequestMeta } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { clearGateToken, readGateToken, writeGateToken } from './gate-cookie';

/** Entrada de un voluntario con el PIN del evento (QA-SEC05, QA-SEC06). La respuesta nunca dice qué ha fallado. */
export async function enterGateAction(eventId: number, pin: string): Promise<'OPENED' | 'INVALID' | 'LOCKED'> {
  const input = z.object({ eventId: z.number().int().positive(), pin: z.string().regex(/^\d{6}$/) }).safeParse({ eventId, pin });
  if (!input.success) return 'INVALID';
  const result = await openGateSession(getPrisma(), getEnv().DATA_HMAC_SECRET, { initiativeId: input.data.eventId, pin: input.data.pin, requestMeta: await currentRequestMeta() });
  if (result.status === 'OPENED') await writeGateToken(result.token, result.expiresAt);
  return result.status;
}

export async function leaveGateAction(): Promise<void> {
  const token = await readGateToken();
  if (token) await closeGateSessionByToken(getPrisma(), getEnv().DATA_HMAC_SECRET, token);
  await clearGateToken();
}
