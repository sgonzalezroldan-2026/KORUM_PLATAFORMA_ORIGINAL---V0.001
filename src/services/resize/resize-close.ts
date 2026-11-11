import { shrinkReservedMaintenance } from '@/core/finance/quota-reservation';
import { notifySigners } from '@/core/jobs/notify';
import { resizedFigures } from '@/core/resize/resize-figures';
import { parsePollOptions, tallyResizeVotes } from '@/core/resize/resize-rules';
import { inTransaction, QUEUED_TRANSACTION, type Db } from '@/lib/db';
import { DONOR_RECIPIENT_SELECT, donorRecipient } from '@/services/notifications/donor-recipient';
import { queueSupporterBroadcast } from '@/services/notifications/supporter-broadcast';
import { approveRefundInTx } from '@/services/payments/payment-reversals';

/**
 * Cierre de las votaciones de redimensionamiento a los 7 días (Sprint 4.4b), desde la tarea `CAMPAIGN_EXPIRY` (corre antes que `MASS_REFUND`). Cada paso en
 * su transacción, con la fila de la iniciativa bloqueada (los votos bloquean la misma): el recuento es definitivo.
 *
 * - **Gana un proyecto** (la opción más votada, sin empate). La propuesta se hace **solo con el dinero de quienes votaron una opción de proyecto** (también
 *   la que perdió: participaron en la decisión). **A quien no votó se le devuelve el 100 %**, porque el compromiso de devolución sigue en pie para quien no
 *   acepta la propuesta (decisión del promotor, 2026-11-11). Por eso se cierra en dos pasos: (1) el recuento (`talliedAt` y la opción ganadora; ya no se
 *   vota) y (2) las devoluciones de quien no votó, por lotes, y al terminar la meta nueva (lo que queda), las comisiones proporcionales (redondeo a favor de
 *   la entidad), el desglose que sigue sumando la meta, la diferencia de mantenimiento devuelta al cupo, `GOAL_REACHED` y los avisos.
 * - **Sin votos de proyecto, con empate o sin nada en la hucha:** `REFUNDING`, y `MASS_REFUND` devuelve el 100 % a todas las personas.
 *
 * Solo cuentan los votos de proyecto de quien **aún tiene alguna donación completada** en la campaña: un voto cuya donación se contracargó o se devolvió
 * por otra vía ya no decide sobre el dinero de las demás personas (auditoría de seguridad del 4.4b, I1).
 */

export type ResizeCloseOutcome = 'PROJECT' | 'NO_VOTES' | 'TIE' | 'NOTHING_LEFT';
/**
 * Devoluciones a quien no votó aprobadas en cada transacción: una campaña con miles de donaciones no cabe en una sola. Con 25 y el margen de
 * `QUEUED_TRANSACTION` (30 s), cada lote cabe holgado aunque la base esté lejos (reauditoría financiera, M1: con el límite de 5 s de Prisma, un lote lento
 * se deshacía entero y la votación quedaba atascada).
 */
export const NON_VOTER_REFUND_BATCH = 25;

/**
 * Cierra las votaciones vencidas. Si una falla, las demás siguen y el primer error se devuelve (`failure`) para que la tarea lo relance **después** de
 * vencer las campañas del día: un cierre roto no puede dejar sin vencer al resto de la plataforma (auditoría financiera, H3). Una que no termina sus
 * devoluciones antes del límite de tiempo sigue en la ejecución siguiente (`hasMore`).
 */
export async function closeDueResizePolls(db: Db, now: Date, batchSize: number, deadline?: number): Promise<{ closed: number; resized: number; refunding: number; failed: number; hasMore: boolean; failure: unknown }> {
  const due = await db.resizePoll.findMany({ where: { status: 'OPEN', closesAt: { lte: now } }, orderBy: { id: 'asc' }, take: batchSize, select: { id: true } });
  const counts = { closed: 0, resized: 0, refunding: 0, failed: 0 };
  let failure: unknown = null;
  let pending = false;
  for (const { id } of due) {
    if (deadline !== undefined && Date.now() > deadline) return { ...counts, hasMore: true, failure };
    let outcome: ResizeCloseOutcome | 'PENDING' | null;
    try {
      outcome = await closeResizePoll(db, id, now, deadline);
    } catch (error) {
      counts.failed += 1;
      failure ??= error;
      continue;
    }
    if (outcome === 'PENDING') pending = true;
    if (!outcome || outcome === 'PENDING') continue;
    counts.closed += 1;
    if (outcome === 'PROJECT') counts.resized += 1;
    else counts.refunding += 1;
  }
  return { ...counts, hasMore: pending || due.length - counts.failed >= batchSize, failure };
}

/** Recuento, devoluciones a quien no votó y cierre de una votación. `PENDING`: quedan devoluciones y se acabó el tiempo; `null`: no tocaba. */
export async function closeResizePoll(db: Db, pollId: number, now: Date, deadline?: number): Promise<ResizeCloseOutcome | 'PENDING' | null> {
  const tallied = await tallyPoll(db, pollId, now);
  if (tallied !== 'TALLIED') return tallied;
  for (;;) {
    const step = await refundNonVotersOrFinish(db, pollId, now);
    if (step !== 'MORE') return step;
    if (deadline !== undefined && Date.now() > deadline) return 'PENDING';
  }
}

async function lockPoll(tx: Db, pollId: number) {
  const reference = await tx.resizePoll.findUniqueOrThrow({ where: { id: pollId }, select: { initiativeId: true } });
  await tx.initiative.updateMany({ where: { id: reference.initiativeId }, data: { ticketsHeld: { increment: 0 } } });
  const poll = await tx.resizePoll.findUniqueOrThrow({
    where: { id: pollId },
    select: { id: true, status: true, closesAt: true, talliedAt: true, winningOptionIndex: true, optionsJson: true, originalGoalCents: true, resultJson: true, votes: { select: { optionIndex: true, wantsRefund: true, canonicalEmail: true } } }
  });
  const initiative = await tx.initiative.findUniqueOrThrow({
    where: { id: reference.initiativeId },
    select: { id: true, organizationId: true, status: true, raisedCents: true, goalCents: true, bracketFeeCents: true, maintFeeCents: true, gatewayFeeCents: true, costMatCents: true, costInstCents: true, contingencyBps: true }
  });
  return { poll, initiative };
}

const auditOf = (tx: Db, organizationId: string, initiativeId: number, pollId: number) => (action: string, metadata: Record<string, number | string | number[]>) =>
  tx.auditLog.create({ data: { actorType: 'SYSTEM', organizationId, action, targetType: 'Initiative', targetId: String(initiativeId), metadataJson: { pollId, ...metadata } } });

/** Donaciones aún completadas de la campaña, con la persona detrás (`null` si ya no se puede saber quién es). */
async function completedDonations(tx: Db, initiativeId: number) {
  const rows = await tx.contribution.findMany({ where: { initiativeId, type: 'DONATION', status: 'COMPLETED' }, orderBy: { id: 'asc' }, select: { id: true, ...DONOR_RECIPIENT_SELECT } });
  return rows.map((row) => ({ id: row.id, canonical: donorRecipient(row)?.canonical ?? null }));
}

/** Paso 1: el recuento. Sin proyecto, se cierra ya hacia `REFUNDING`; con proyecto, queda la opción ganadora y empiezan las devoluciones. */
async function tallyPoll(db: Db, pollId: number, now: Date): Promise<ResizeCloseOutcome | 'TALLIED' | null> {
  return inTransaction(db, async (tx) => {
    const { poll, initiative } = await lockPoll(tx, pollId);
    if (poll.status !== 'OPEN' || poll.closesAt > now) return null;
    if (poll.talliedAt) return 'TALLIED';
    const options = parsePollOptions(poll.optionsJson);
    const stillDonors = new Set((await completedDonations(tx, initiative.id)).flatMap((row) => row.canonical ?? []));
    const tally = tallyResizeVotes(poll.votes.filter((vote) => vote.wantsRefund || stillDonors.has(vote.canonicalEmail)), options.length);
    const result = { counts: tally.counts, refundVotes: tally.refundVotes, outcome: tally.outcome, raisedAtTallyCents: initiative.raisedCents };
    if (tally.outcome === 'PROJECT' && tally.winningOptionIndex !== null && initiative.status === 'RESIZE_VOTING') {
      await tx.resizePoll.update({ where: { id: pollId }, data: { talliedAt: now, winningOptionIndex: tally.winningOptionIndex, resultJson: result } });
      await auditOf(tx, initiative.organizationId, initiative.id, pollId)('resize.tallied', { winningOptionIndex: tally.winningOptionIndex, counts: tally.counts, refundVotes: tally.refundVotes });
      return 'TALLIED';
    }
    return closeWithoutProject(tx, pollId, initiative, tally.outcome === 'PROJECT' ? 'NOTHING_LEFT' : tally.outcome, result, now);
  }, QUEUED_TRANSACTION);
}

async function closeWithoutProject(tx: Db, pollId: number, initiative: { id: number; organizationId: string; status: string }, outcome: Exclude<ResizeCloseOutcome, 'PROJECT'>, result: Record<string, unknown>, now: Date): Promise<ResizeCloseOutcome> {
  await tx.resizePoll.update({ where: { id: pollId }, data: { status: 'CLOSED_REJECTED', closedAt: now, winningOptionIndex: null, resultJson: { ...result, outcome } } });
  // Si la campaña ya no estaba en votación (no debería pasar: nada la saca de ahí salvo este cierre), se cierra la votación sin tocar su estado.
  if (initiative.status !== 'RESIZE_VOTING') return outcome;
  await tx.initiative.update({ where: { id: initiative.id }, data: { status: 'REFUNDING' } });
  await auditOf(tx, initiative.organizationId, initiative.id, pollId)('initiative.resize_rejected', { outcome });
  await notifySigners(tx, initiative.organizationId, 'initiative.resizeClosed', `${initiative.id}`, { initiativeId: initiative.id, outcome });
  await queueSupporterBroadcast(tx, initiative.id, 'initiative.refundingSupporter', now);
  return outcome;
}

/**
 * Paso 2: devuelve (aprueba; `MASS_REFUND` la envía) su aportación a un lote de quienes no votaron una opción de proyecto. Sin nadie más a quien
 * devolver, fija la meta nueva con lo que queda y cierra. `MORE`: queda otro lote.
 */
async function refundNonVotersOrFinish(db: Db, pollId: number, now: Date): Promise<ResizeCloseOutcome | 'MORE' | null> {
  return inTransaction(db, async (tx) => {
    const { poll, initiative } = await lockPoll(tx, pollId);
    if (poll.status !== 'OPEN' || !poll.talliedAt || poll.winningOptionIndex === null) return null;
    const audit = auditOf(tx, initiative.organizationId, initiative.id, pollId);
    const projectVoters = new Set(poll.votes.flatMap((vote) => (vote.wantsRefund ? [] : [vote.canonicalEmail])));
    const nonVoters = (await completedDonations(tx, initiative.id)).filter((row) => row.canonical === null || !projectVoters.has(row.canonical));
    const batch = nonVoters.slice(0, NON_VOTER_REFUND_BATCH);
    for (const donation of batch) await approveRefundInTx(tx, donation.id, { at: now });
    if (batch.length > 0) {
      await audit('resize.non_voters_refunded', { donations: batch.length });
      return 'MORE';
    }

    const previous = (poll.resultJson ?? {}) as Record<string, unknown>;
    const newGoalCents = Math.min(initiative.raisedCents, poll.originalGoalCents);
    if (newGoalCents <= 0 || initiative.status !== 'RESIZE_VOTING') return closeWithoutProject(tx, pollId, initiative, 'NOTHING_LEFT', previous, now);
    const figures = resizedFigures({
      originalGoalCents: poll.originalGoalCents,
      newGoalCents,
      bracketFeeCents: initiative.bracketFeeCents,
      maintFeeCents: initiative.maintFeeCents,
      gatewayFeeCents: initiative.gatewayFeeCents,
      costMatCents: initiative.costMatCents,
      costInstCents: initiative.costInstCents,
      contingencyBps: initiative.contingencyBps
    });
    await tx.initiative.update({
      where: { id: initiative.id },
      data: {
        status: 'GOAL_REACHED',
        stepIndex: 5,
        goalCents: figures.goalCents,
        bracketFeeCents: figures.bracketFeeCents,
        maintFeeCents: figures.maintFeeCents,
        gatewayFeeCents: figures.gatewayFeeCents,
        costMatCents: figures.costMatCents,
        costInstCents: figures.costInstCents
      }
    });
    const { releasedCents } = await shrinkReservedMaintenance(tx, initiative.id, figures.maintFeeCents);
    await tx.resizePoll.update({
      where: { id: pollId },
      data: {
        status: 'CLOSED_APPROVED',
        closedAt: now,
        newGoalCents: figures.goalCents,
        resultJson: { ...previous, outcome: 'PROJECT', before: { goalCents: initiative.goalCents, bracketFeeCents: initiative.bracketFeeCents, maintFeeCents: initiative.maintFeeCents, gatewayFeeCents: initiative.gatewayFeeCents }, maintQuotaReleasedCents: releasedCents }
      }
    });
    const options = parsePollOptions(poll.optionsJson);
    await audit('initiative.resized', { winningOptionIndex: poll.winningOptionIndex, newGoalCents: figures.goalCents, originalGoalCents: poll.originalGoalCents });
    await notifySigners(tx, initiative.organizationId, 'initiative.resizeClosed', `${initiative.id}`, { initiativeId: initiative.id, outcome: 'PROJECT', newGoalCents: figures.goalCents, option: options[poll.winningOptionIndex] ?? '' });
    await queueSupporterBroadcast(tx, initiative.id, 'initiative.resizeResult', now);
    return 'PROJECT';
  }, QUEUED_TRANSACTION);
}
