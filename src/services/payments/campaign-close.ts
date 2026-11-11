import { notifySigners } from '@/core/jobs/notify';
import type { Db } from '@/lib/db';
import { queuePhotosBroadcastIfReady } from '@/services/notifications/supporter-broadcast';

/**
 * Cierre de una iniciativa al terminar de enviarse su liquidación (PRD §4.1, `GOAL_REACHED ──doble firma + split transfer──► CLOSED`, Sprint 4.4a), en la
 * transacción que marca la liquidación como hecha. Aviso `payout.executed` a quienes firman (con el paso siguiente: las fotos del Después) y, si las dos
 * fotos ya estaban, el aviso con el Antes y el Después a quienes donaron. Solo cierra una iniciativa en `GOAL_REACHED`: repetirlo no hace nada.
 */
export async function closeInitiativeAfterPayout(
  tx: Db,
  payout: { payoutId: number; initiativeId: number; organizationId: string; netPaidCents: number; destinationType: 'ORGANIZATION' | 'PROVIDER' },
  now: Date
): Promise<boolean> {
  const { count } = await tx.initiative.updateMany({ where: { id: payout.initiativeId, status: 'GOAL_REACHED' }, data: { status: 'CLOSED', closedAt: now, stepIndex: 6 } });
  if (count === 0) return false;
  await tx.auditLog.create({ data: { actorType: 'SYSTEM', organizationId: payout.organizationId, action: 'initiative.closed', targetType: 'Initiative', targetId: String(payout.initiativeId), metadataJson: { payoutId: payout.payoutId, netPaidCents: payout.netPaidCents } } });
  await notifySigners(tx, payout.organizationId, 'payout.executed', `payout:${payout.payoutId}`, {
    initiativeId: payout.initiativeId,
    payoutId: payout.payoutId,
    amountCents: payout.netPaidCents,
    destinationType: payout.destinationType
  });
  await queuePhotosBroadcastIfReady(tx, payout.initiativeId, now);
  return true;
}
