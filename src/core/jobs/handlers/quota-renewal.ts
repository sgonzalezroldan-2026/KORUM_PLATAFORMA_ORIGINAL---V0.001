import { academicYearFor } from '@/core/finance/academic-year';
import { renewOrganizationQuotas } from '@/core/finance/quota-reservation';
import type { JobHandler } from '../job-types';

/** Páginas como máximo por ejecución: cota de seguridad (100 por página); lo que quede lo recoge la siguiente ejecución. */
const MAX_PAGES = 50;

/**
 * `QUOTA_RENEWAL`: cada entidad cuyo curso de cupos ya no es el vigente pasa al nuevo (exento, beca de medalla, mantenimiento y campañas
 * cerradas del año). Recorre **todas** las pendientes en una sola ejecución —el hueco entre el cambio de curso y la renovación de una entidad no
 * puede durar días—, y repetirla no hace nada porque cada entidad solo avanza de curso una vez. Una entidad sin curso asignado solo recibe el
 * curso, sin reposición (ver `renewOrganizationQuotas`). Además, publicar una campaña renueva su entidad si hace falta
 * (`reserveInitiativeQuotas`), así que ni siquiera las horas hasta esta tarea regalan cupo del curso anterior. Cada cambio deja su línea en
 * `AuditLog` (`quota.renewed` o `quota.period_assigned`).
 */
export const quotaRenewalHandler: JobHandler = async ({ db, now, batchSize }) => {
  const period = academicYearFor(now);
  let processed = 0;
  let renewed = 0;
  let hasMore = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const stale = await db.organization.findMany({
      where: { archivedAt: null, OR: [{ quotaPeriod: null }, { quotaPeriod: { lt: period } }] },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true }
    });
    if (stale.length === 0) break;
    let progressed = 0;
    for (const { id } of stale) {
      processed += 1;
      const result = await renewOrganizationQuotas(db, id, period);
      if (!result.renewed) continue;
      progressed += 1;
      renewed += 1;
    }
    // Si una página entera no avanzó (entidades que no se pueden renovar), no se vuelve a pedir la misma: se evita un bucle sin fin.
    if (progressed === 0) break;
    hasMore = page === MAX_PAGES - 1;
  }
  return { processed, hasMore, detail: { renewed } };
};
