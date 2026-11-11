import { notifySigners } from '@/core/jobs/notify';
import type { Db } from '@/lib/db';
import { queueSupporterBroadcast } from '@/services/notifications/supporter-broadcast';

/**
 * Una campaña llega a su meta (`FUNDRAISING → GOAL_REACHED`), en la transacción del cobro que la completa: aviso a quienes firman (toca liquidar) y, desde
 * el Sprint 4.4a, el aviso «¡Lo hemos conseguido!» a quienes donaron, que reparte por lotes la tarea `SUPPORTER_BROADCAST` (uno por iniciativa: si un
 * contracargo la devuelve a recaudar y la vuelve a completar, no se repite). Quien llama ya ha comprobado el estado con la fila bloqueada.
 */
export async function markGoalReached(tx: Db, organizationId: string, initiativeId: number, now: Date): Promise<void> {
  await tx.initiative.update({ where: { id: initiativeId }, data: { status: 'GOAL_REACHED', stepIndex: 5 } });
  await notifySigners(tx, organizationId, 'initiative.goalReached', String(initiativeId), { initiativeId });
  await queueSupporterBroadcast(tx, initiativeId, 'initiative.goalReachedSupporter', now);
}
