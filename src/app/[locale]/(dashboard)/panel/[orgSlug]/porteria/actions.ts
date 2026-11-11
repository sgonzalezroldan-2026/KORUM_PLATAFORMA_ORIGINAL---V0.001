'use server';

import { z } from 'zod';
import { getEnv } from '@/config/env';
import { GATE_CODE_PATTERN } from '@/core/ticketing/gate-code';
import { closeGateSessionByToken, openGateSession } from '@/core/ticketing/gate-session.service';
import { dispatchOutboxSoon } from '@/lib/panel/outbox-soon';
import { getPrisma } from '@/lib/prisma';
import { raiseTrustedIpAlert } from '@/services/ideas/idea-requests.service';
import { clearGateToken, readGateToken, writeGateToken } from './gate-cookie';
import { gateRequestMeta } from './gate-request';

/** Entrada de un voluntario con el PIN del evento (QA-SEC05, QA-SEC06). La respuesta nunca dice qué ha fallado. */
export async function enterGateAction(gateCode: string, pin: string, deviceLabel?: string): Promise<'OPENED' | 'INVALID' | 'LOCKED'> {
  const input = z.object({ gateCode: z.string().regex(GATE_CODE_PATTERN), pin: z.string().regex(/^\d{6}$/), deviceLabel: z.string().trim().max(40).optional() }).safeParse({ gateCode, pin, deviceLabel: deviceLabel?.trim() || undefined });
  if (!input.success) return 'INVALID';
  const db = getPrisma();
  const { trustedIp, ...meta } = await gateRequestMeta();
  // El evento se busca por su código no adivinable; un código desconocido pasa igualmente por el límite de la red (con el evento 0) y responde como un PIN malo.
  const initiativeId = (await db.initiative.findUnique({ where: { gateCode: input.data.gateCode }, select: { id: true } }))?.id ?? 0;
  const result = await openGateSession(db, getEnv().DATA_HMAC_SECRET, { initiativeId, pin: input.data.pin, deviceLabel: input.data.deviceLabel, requestMeta: meta });
  // Sin IP válida todos los voluntarios comparten grupo y 5 fallos de uno bloquean a todos: se avisa a la consola (una sola alerta), después del límite de la red:
  // una petición bloqueada no escribe nada más.
  if (!trustedIp && result.status !== 'LOCKED') await raiseTrustedIpAlert(db, 'porteria', new Date());
  // Si este intento acaba de anular el PIN, el aviso a quienes firman sale ya (la tarea de la bandeja corre una vez al día): la cola de la puerta no puede esperar.
  if ('outboxIds' in result && result.outboxIds) dispatchOutboxSoon(db, result.outboxIds, 'outbox-after-pin-revoked');
  if (result.status === 'OPENED') await writeGateToken(result.token, result.expiresAt);
  return result.status;
}

export async function leaveGateAction(): Promise<void> {
  const token = await readGateToken();
  if (token) await closeGateSessionByToken(getPrisma(), getEnv().DATA_HMAC_SECRET, token);
  await clearGateToken();
}
