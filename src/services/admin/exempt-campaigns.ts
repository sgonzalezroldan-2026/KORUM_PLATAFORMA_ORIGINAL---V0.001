import type { Db } from '@/lib/db';

/**
 * Campañas al 0 % para revisar (Sprint 5.3, aplazado del 5.1): el candado semántico es un filtro de buena fe (DECISIONES_TECNICAS §2.15), así que cada guardado de una
 * campaña de presupuesto en una categoría exenta deja `studio.exempt_category_saved` y, si el texto activó el candado, `studio.semantic_lock_triggered` (o
 * `studio.semantic_lock_after_publish` con la campaña ya recaudando). Aquí se listan las que **siguen** en una categoría al 0 %, las más recientes primero, con
 * una marca si el candado saltó alguna vez. Las taquillas no entran: su exención es por diseño. Quien llama ya pasó `authorizeSuperadmin`. Sin datos personales.
 */

export interface ExemptCampaignRow {
  initiativeId: number;
  title: string;
  category: string;
  status: string;
  organizationId: string;
  organizationName: string;
  goalCents: number;
  lastSavedAt: string;
  /** El candado semántico saltó alguna vez en esta campaña: el texto parecía de equipamiento. */
  lockTriggered: boolean;
}

const AUDIT_WINDOW = 500;
const LIMIT = 50;
const HIDDEN_STATUSES = ['CANCELLED'] as const;

/**
 * «Al 0 %» se decide con lo que se **aplicó al calcular la campaña** (comisión por tramos, exento por defecto y beca de medalla, los tres a 0 con una meta mayor que 0),
 * no con la regla actual de la categoría: si una categoría pasa después a «por tramos» (`setGlobalCategoryRule`), las campañas que ya se calcularon al 0 % siguen ahí
 * para revisarlas (auditoría financiera del 5.3, M6).
 */
export async function loadExemptCampaigns(db: Db): Promise<ExemptCampaignRow[]> {
  const saves = await db.auditLog.findMany({ where: { action: 'studio.exempt_category_saved' }, orderBy: { id: 'desc' }, take: AUDIT_WINDOW, select: { targetId: true, occurredAt: true } });
  const lastSaved = new Map<number, Date>();
  for (const save of saves) {
    const id = Number(save.targetId);
    if (Number.isSafeInteger(id) && id > 0 && !lastSaved.has(id)) lastSaved.set(id, save.occurredAt);
  }
  if (lastSaved.size === 0) return [];

  const ids = [...lastSaved.keys()];
  const [initiatives, locks] = await Promise.all([
    db.initiative.findMany({
      where: { id: { in: ids }, format: 'BUDGET', status: { notIn: [...HIDDEN_STATUSES] }, goalCents: { gt: 0 }, bracketFeeCents: 0, defaultExemptAppliedCents: 0, medalExemptAppliedCents: 0 },
      select: { id: true, title: true, category: true, status: true, goalCents: true, organizationId: true, organization: { select: { name: true } } }
    }),
    db.auditLog.findMany({ where: { action: { in: ['studio.semantic_lock_triggered', 'studio.semantic_lock_after_publish'] }, targetType: 'Initiative', targetId: { in: ids.map(String) } }, select: { targetId: true }, distinct: ['targetId'] })
  ]);
  const locked = new Set(locks.map((lock) => Number(lock.targetId)));

  return initiatives
    .map(
      (initiative): ExemptCampaignRow => ({
        initiativeId: initiative.id,
        title: initiative.title,
        category: initiative.category,
        status: initiative.status,
        organizationId: initiative.organizationId,
        organizationName: initiative.organization.name,
        goalCents: initiative.goalCents,
        lastSavedAt: (lastSaved.get(initiative.id) ?? new Date(0)).toISOString(),
        lockTriggered: locked.has(initiative.id)
      })
    )
    .sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt))
    .slice(0, LIMIT);
}
