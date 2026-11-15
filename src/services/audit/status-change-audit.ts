import type { AuditInitiativeStatus, StatusChangeReason } from '@/core/audit/audit-catalog';
import type { Db } from '@/lib/db';

/**
 * Rastro de cada cambio de estado de una iniciativa, con su motivo (Sprint 5.8a, trazabilidad). Antes solo algunos cambios dejaban una fila propia
 * (`initiative.expired`, `initiative.closed`…) y otros ninguna (publicar, lograr la meta, volver a recaudar por un contracargo): reconstruir la vida de una
 * campaña obligaba a deducirla del libro mayor. Ahora **todo** cambio escribe `initiative.status_changed` con el estado anterior, el nuevo y el motivo, en la
 * misma transacción que el cambio: o quedan los dos o ninguno. `tests/unit/status-change-audit.spec.ts` vigila que ningún cambio de estado del código se
 * quede sin su llamada.
 *
 * Solo identificadores y estados: ningún dato personal. Quien lo provoca es una persona (publicar, descartar, decidir sobre una campaña vencida) o el
 * sistema (un cobro que completa la meta, una tarea programada, un contracargo).
 */
export interface StatusChange {
  initiativeId: number;
  organizationId: string;
  from: AuditInitiativeStatus;
  to: AuditInitiativeStatus;
  reason: StatusChangeReason;
  /** Persona que lo provoca; sin ella, el cambio es del sistema. */
  actorUserId?: string | null;
  /**
   * Cuenta de KORUM cuya operación desencadenó un cambio que, para la entidad, es del sistema (el Auto-Impulso que completa la meta). Va solo en el detalle
   * guardado, que la entidad no ve: si fuera el actor, su registro diría «KORUM» justo donde el promotor decidió que no se dijera (2026-11-15).
   */
  triggeredByUserId?: string | null;
}

export async function recordStatusChange(tx: Pick<Db, 'auditLog'>, change: StatusChange): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorType: change.actorUserId ? 'USER' : 'SYSTEM',
      actorUserId: change.actorUserId ?? null,
      organizationId: change.organizationId,
      action: 'initiative.status_changed',
      targetType: 'Initiative',
      targetId: String(change.initiativeId),
      metadataJson: { initiativeId: change.initiativeId, from: change.from, to: change.to, reason: change.reason, ...(change.triggeredByUserId ? { triggeredByUserId: change.triggeredByUserId } : {}) }
    }
  });
}
