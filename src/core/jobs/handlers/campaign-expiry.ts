import { returnSelfBoostToKorum } from '@/core/finance/self-boost-return';
import { isGoalMet } from '@/core/ticketing/ticket-goal';
import { raiseAlert } from '../ops-alerts';
import { inTransaction, type Db } from '@/lib/db';
import { closeDueResizePolls } from '@/services/resize/resize-close';
import { notifyIndexNow } from '@/services/seo/indexnow.service';
import type { JobHandler } from '../job-types';
import { notifySigners } from '../notify';

/**
 * `CAMPAIGN_EXPIRY` (PRD §4.1): una iniciativa `FUNDRAISING` cuya fecha límite ha pasado sin llegar a la meta pasa a `EXPIRED`, una
 * sola vez, y se avisa a quienes firman. Desde ahí decide la entidad (votación de redimensionamiento o reembolso): el cron no
 * reembolsa por su cuenta. Un evento ya celebrado que logró su meta está en `GOAL_REACHED` y nunca entra aquí.
 *
 * Si la campaña llevaba un Auto-Impulso de KORUM (se reabrió por un contracargo tras completarse), ese dinero vuelve a KORUM en el mismo acto con un
 * contra-asiento (Sprint 5.2): no es de ninguna familia, así que el reembolso o la votación solo manejan lo de las personas.
 *
 * Desde el Sprint 4.4b cierra además las votaciones de redimensionamiento cuyos 7 días han pasado (`closeDueResizePolls`): corre antes que `MASS_REFUND`,
 * así que una votación sin proyecto empieza a devolverse el mismo día.
 *
 * Desde el Sprint 5.5b, al terminar avisa a IndexNow de las iniciativas públicas que han cambiado (vencidas hoy, conseguidas o cerradas desde el último aviso):
 * es el barrido diario de respaldo. Nunca hace fallar la tarea.
 */
export const campaignExpiryHandler: JobHandler = async ({ db, now, batchSize, deadline, deps }) => {
  let expired = 0;
  let examined = 0;
  let cursor = 0;
  // Una campaña que no se puede vencer (p. ej. su Auto-Impulso no tiene asiento) no frena a las demás: se anota, se avisa y la tarea falla al final.
  let failure: unknown = null;
  const polls = await closeDueResizePolls(db, now, batchSize, deadline);
  const pollDetail = { pollsClosed: polls.closed, resized: polls.resized, pollsRefunding: polls.refunding, pollsFailed: polls.failed };
  // Una votación que no terminó sus devoluciones (o más votaciones de las que caben) no retrasa el vencimiento de las campañas del día (reauditoría, L2).
  // Recorre las candidatas por identificador: las que no pueden caducar (p. ej. una rifa ya sorteada) no se quedan al principio de la cola y no dejan sin atender a las demás.
  for (;;) {
    const page = await db.initiative.findMany({ where: { status: 'FUNDRAISING', closesAt: { lte: now }, id: { gt: cursor } }, orderBy: { id: 'asc' }, take: batchSize, select: { id: true } });
    for (const { id } of page) {
      try {
        if (await expireIfDue(db, id, now)) expired += 1;
      } catch (error) {
        failure ??= error;
        await raiseAlert(db, { type: 'JOB_FAILED', severity: 'CRITICAL', dedupeKey: `CAMPAIGN_EXPIRY:${id}`, targetType: 'Initiative', targetId: String(id), detail: { job: 'CAMPAIGN_EXPIRY', error: error instanceof Error ? error.message.slice(0, 300) : 'desconocido' } }, now);
      }
    }
    examined += page.length;
    const last = page[page.length - 1];
    if (!last || page.length < batchSize) {
      // Las campañas ya han vencido: ahora sí, la tarea falla por la votación que no se pudo cerrar (reintento con espera y alerta JOB_FAILED).
      const indexNow = await notifyIndexNow({ db, keyring: () => deps.keyring() });
      if (polls.failure !== null) throw polls.failure;
      if (failure !== null) throw failure;
      return { processed: examined + polls.closed, hasMore: polls.hasMore, detail: { expired, ...pollDetail, indexNowUrls: indexNow.status === 'SENT' ? indexNow.urls : 0 } };
    }
    if (deadline !== undefined && Date.now() > deadline) {
      if (failure !== null) throw failure;
      return { processed: examined + polls.closed, hasMore: true, detail: { expired, ...pollDetail } };
    }
    cursor = last.id;
  }
};

async function expireIfDue(db: Db, id: number, now: Date): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    // Bloquea la fila: un cobro que llega a la vez no puede cumplir la meta entre la lectura y el cambio de estado.
    await tx.initiative.updateMany({ where: { id }, data: { ticketsHeld: { increment: 0 } } });
    const initiative = await tx.initiative.findUniqueOrThrow({
      where: { id },
      select: { organizationId: true, format: true, status: true, closesAt: true, raisedCents: true, goalCents: true, ticketsSold: true, ticketMax: true, walletEscrowId: true, _count: { select: { raffleDraws: true } } }
    });
    if (initiative.status !== 'FUNDRAISING' || initiative.closesAt > now || isGoalMet(initiative) || initiative._count.raffleDraws > 0) return false;
    const { count } = await tx.initiative.updateMany({ where: { id, status: 'FUNDRAISING' }, data: { status: 'EXPIRED' } });
    if (count !== 1) return false;
    const selfBoostReturnedCents = await returnSelfBoostToKorum(tx, id, now);
    const raisedCents = initiative.raisedCents - selfBoostReturnedCents;
    await tx.auditLog.create({ data: { actorType: 'SYSTEM', organizationId: initiative.organizationId, action: 'initiative.expired', targetType: 'Initiative', targetId: String(id), metadataJson: { raisedCents, goalCents: initiative.goalCents, selfBoostReturnedCents } } });
    await notifySigners(tx, initiative.organizationId, 'initiative.expired', String(id), { initiativeId: id, walletEscrowId: initiative.walletEscrowId, raisedCents, goalCents: initiative.goalCents });
    return true;
  });
}
