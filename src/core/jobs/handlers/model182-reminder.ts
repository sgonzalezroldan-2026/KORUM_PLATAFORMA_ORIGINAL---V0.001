import type { JobHandler } from '../job-types';
import { notifySigners } from '../notify';

/**
 * `MODEL182_REMINDER` (2 de enero): recuerda a quienes firman, en cada entidad con la Ley 49/2002 verificada que cobró donaciones el
 * ejercicio anterior, que ya pueden exportar el Modelo 182. Las entradas no cuentan (Regla 02 §8); solo las donaciones completadas y sin
 * devolver. Un aviso por entidad y ejercicio, aunque la tarea se repita.
 */
export const model182ReminderHandler: JobHandler = async ({ db, now, batchSize }) => {
  const fiscalYear = now.getUTCFullYear() - 1;
  let cursor: string | undefined;
  let processed = 0;
  let notified = 0;
  for (;;) {
    const organizations = await db.organization.findMany({
      where: { ley49: true, ley49VerifiedAt: { not: null }, archivedAt: null, contributions: { some: { type: 'DONATION', status: 'COMPLETED', fiscalYear } } },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true }
    });
    for (const { id } of organizations) notified += await notifySigners(db, id, 'model182.reminder', `${id}:${fiscalYear}`, { fiscalYear });
    processed += organizations.length;
    const last = organizations.at(-1);
    if (!last || organizations.length < batchSize) break;
    cursor = last.id;
  }
  return { processed, hasMore: false, detail: { fiscalYear, notified } };
};
