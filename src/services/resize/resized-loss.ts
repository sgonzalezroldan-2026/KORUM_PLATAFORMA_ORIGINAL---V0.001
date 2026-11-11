import { shrinkReservedMaintenance } from '@/core/finance/quota-reservation';
import { resizedFigures } from '@/core/resize/resize-figures';
import type { Db } from '@/lib/db';

/**
 * Una campaña redimensionada por votación (Sprint 4.4b) que pierde dinero antes de liquidarse (un contracargo): no vuelve a recaudar, así que su meta baja
 * a lo que queda y las comisiones vuelven a bajar en la misma proporción, hacia abajo (auditoría financiera del 4.4b, H1). Sin esto, un contracargo grande
 * dejaba el neto en negativo, la campaña sin poder liquidarse ni devolverse y el dinero de las demás familias atascado. Si no queda nada, pasa a
 * `REFUNDING` y `MASS_REFUND` la cierra (`REFUNDED`, cupos devueltos). Se llama en la transacción del contracargo, con la fila de la iniciativa bloqueada;
 * una liquidación pedida deja de cuadrar y se vuelve a pedir y a firmar.
 */
export async function rescaleResizedAfterLoss(tx: Db, initiativeId: number): Promise<'RESCALED' | 'REFUNDING' | 'UNCHANGED'> {
  const initiative = await tx.initiative.findUniqueOrThrow({
    where: { id: initiativeId },
    select: { organizationId: true, status: true, raisedCents: true, goalCents: true, bracketFeeCents: true, maintFeeCents: true, gatewayFeeCents: true, costMatCents: true, costInstCents: true, contingencyBps: true }
  });
  if (initiative.status !== 'GOAL_REACHED' || initiative.raisedCents >= initiative.goalCents) return 'UNCHANGED';
  const audit = (action: string, metadata: Record<string, number>) =>
    tx.auditLog.create({ data: { actorType: 'SYSTEM', organizationId: initiative.organizationId, action, targetType: 'Initiative', targetId: String(initiativeId), metadataJson: metadata } });
  if (initiative.raisedCents <= 0) {
    await tx.initiative.update({ where: { id: initiativeId }, data: { status: 'REFUNDING' } });
    await audit('initiative.resized_emptied', { goalCents: initiative.goalCents });
    return 'REFUNDING';
  }
  const figures = resizedFigures({
    originalGoalCents: initiative.goalCents,
    newGoalCents: initiative.raisedCents,
    bracketFeeCents: initiative.bracketFeeCents,
    maintFeeCents: initiative.maintFeeCents,
    gatewayFeeCents: initiative.gatewayFeeCents,
    costMatCents: initiative.costMatCents,
    costInstCents: initiative.costInstCents,
    contingencyBps: initiative.contingencyBps
  });
  await tx.initiative.update({
    where: { id: initiativeId },
    data: { goalCents: figures.goalCents, bracketFeeCents: figures.bracketFeeCents, maintFeeCents: figures.maintFeeCents, gatewayFeeCents: figures.gatewayFeeCents, costMatCents: figures.costMatCents, costInstCents: figures.costInstCents }
  });
  await shrinkReservedMaintenance(tx, initiativeId, figures.maintFeeCents);
  await audit('initiative.resized_rescaled', { previousGoalCents: initiative.goalCents, goalCents: figures.goalCents });
  return 'RESCALED';
}
