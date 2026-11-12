import { inTransaction, type Db } from '@/lib/db';
import { expireStaleHandovers } from '@/services/panel/signer-handover.service';
import { resolveAlertsNotIn } from '../ops-alerts';

/**
 * Relevos de firmante caducados (Sprint 5.2, rediseñado el 2026-11-12). Las entidades resuelven sus propios cambios de firmantes y el Super-Admin no gestiona
 * nada de esto: una invitación que nadie aceptó a tiempo (72 horas) se **cierra sola** cada día, sin alerta ni trabajo para soporte, y la entidad puede
 * proponer el relevo de nuevo desde su panel. Las alertas `SIGNER_HANDOVER_EXPIRED` que dejó la versión anterior se cierran.
 */
export async function checkExpiredSignerHandovers(db: Db, now: Date): Promise<number> {
  const expired = await db.signerHandover.findMany({
    where: { status: { in: ['AWAITING_CONSENT', 'INVITED'] }, expiresAt: { lt: now } },
    select: { organizationId: true },
    distinct: ['organizationId']
  });
  let closed = 0;
  for (const { organizationId } of expired) {
    closed += await inTransaction(db, async (tx) => {
      // La fila de la entidad se bloquea antes de cerrar: un cambio de la propia entidad a la vez se ordena con éste.
      await tx.organization.updateMany({ where: { id: organizationId }, data: { updatedAt: now } });
      return expireStaleHandovers(tx, organizationId, now);
    });
  }
  await resolveAlertsNotIn(db, 'SIGNER_HANDOVER_EXPIRED', [], now);
  return closed;
}
