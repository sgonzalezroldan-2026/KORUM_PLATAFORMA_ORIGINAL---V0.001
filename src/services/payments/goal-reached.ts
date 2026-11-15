import { notifySigners } from '@/core/jobs/notify';
import type { Db } from '@/lib/db';
import { queueSupporterBroadcast } from '@/services/notifications/supporter-broadcast';
import { recordStatusChange } from '@/services/audit/status-change-audit';

/**
 * Una campaña llega a su meta (`FUNDRAISING → GOAL_REACHED`), en la transacción del cobro que la completa: aviso a quienes firman (toca liquidar) y, desde
 * el Sprint 4.4a, el aviso «¡Lo hemos conseguido!» a quienes donaron, que reparte por lotes la tarea `SUPPORTER_BROADCAST` (uno por iniciativa: si un
 * contracargo la devuelve a recaudar y la vuelve a completar, no se repite). Quien llama ya ha comprobado el estado con la fila bloqueada.
 */
export async function markGoalReached(tx: Db, organizationId: string, initiativeId: number, now: Date, options: { triggeredByUserId?: string } = {}): Promise<void> {
  // Solo desde `FUNDRAISING` (quien llama ya lo ha comprobado con la fila bloqueada): así el rastro nunca anota una transición que no ocurrió, y si la
  // campaña no estaba recaudando no se cambia nada ni se avisa a nadie.
  const { count } = await tx.initiative.updateMany({ where: { id: initiativeId, organizationId, status: 'FUNDRAISING' }, data: { status: 'GOAL_REACHED', stepIndex: 5 } });
  if (count !== 1) return;
  await recordStatusChange(tx, { initiativeId, organizationId, from: 'FUNDRAISING', to: 'GOAL_REACHED', reason: 'GOAL_REACHED', triggeredByUserId: options.triggeredByUserId });
  await notifySigners(tx, organizationId, 'initiative.goalReached', String(initiativeId), { initiativeId });
  await queueSupporterBroadcast(tx, initiativeId, 'initiative.goalReachedSupporter', now);
}
