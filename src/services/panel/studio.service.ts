import { z } from 'zod';
import { academicYearFor } from '@/core/finance/academic-year';
import { CampaignDurationError, InitiativeNotPublishableError, PublishGoalChangedError, publishInitiative } from '@/core/finance/campaign-window';
import { InsufficientQuotaError, QuotaConcurrencyError } from '@/core/finance/quota-reservation';
import { allocateWalletId, quarterOf } from '@/core/ideas/idea-conversion';
import { computeStudioBoard, evaluateStudioLock, publishBlockers, saveProblems, type PublishBlocker, type StudioBoard, type StudioContext } from '@/core/studio/studio-board';
import { endOfDayInMadrid, studioDraftSchema, TICKETING_CATEGORY, type StudioDraft } from '@/core/studio/studio-draft';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { MAX_OPEN_DRAFTS, loadFreshStudioContext } from '@/repositories/studio.repository';
import { requireOwnedResource } from '@/repositories/ownership';
import { recordAudit, type SessionActor } from '@/repositories/tenant-guard';
import { requireSigner } from './kyb.service';

/**
 * Guardar y publicar desde el Estudio (Sprint 4.3: `saveInitiativeFromStudio` del prototipo). Las dos personas firmantes, con el segundo factor.
 *
 * - **Nada del navegador entra en una cuenta:** el borrador solo trae lo que escribió la entidad; la meta, la comisión, el exento, la beca y la pasarela
 *   los calcula el servidor con el motor TCO y las reglas y cupos de la base de datos (Regla 02 §2). Quien publica manda además la meta que vio
 *   (`expectedGoalCents`): si los cupos cambiaron entretanto, no se publica una cifra distinta de la que se aceptó.
 * - **Qué se puede editar:** en `BUDGETING`, todo. En `FUNDRAISING` solo lo que no mueve dinero (descripción, reto, placa, desglose público): el presupuesto,
 *   el precio, el aforo y la fecha ya los usan las aportaciones y la reserva de cupos. En cualquier otro estado, nada.
 * - **Rastro:** cada guardado deja `studio.initiative_saved`; una categoría al 0 % deja `studio.exempt_category_saved` (el candado semántico es un filtro
 *   de buena fe y el Super-Admin las revisa) y, si el texto lo ha activado, `studio.semantic_lock_triggered`. La confirmación de normativa de una rifa
 *   se escribe en la misma transacción que el guardado y es obligatoria.
 */

export type StudioErrorReason = 'INVALID_INPUT' | 'PROBLEMS' | 'BLOCKED' | 'NOT_EDITABLE' | 'STALE_BOARD' | 'QUOTA' | 'NOT_PUBLISHABLE' | 'TOO_MANY_DRAFTS' | 'SEMANTIC_LOCK';

export class StudioError extends Error {
  constructor(
    readonly reason: StudioErrorReason,
    /** Los motivos concretos (`SaveProblem` o `PublishBlocker`) o los campos no válidos. */
    readonly detail: readonly string[] = [],
    /** Identificador de la campaña si el borrador se guardó antes de fallar la publicación. */
    readonly initiativeId?: number
  ) {
    super(`Estudio: ${reason}${detail.length ? ` (${detail.join(', ')})` : ''}.`);
    this.name = 'StudioError';
  }
}

export interface SavedStudioDraft {
  initiativeId: number;
  status: 'BUDGETING' | 'FUNDRAISING' | 'OTHER';
  goalCents: number;
  created: boolean;
}

const publishInputSchema = z.object({ draft: studioDraftSchema, expectedGoalCents: z.number().int().min(0) }).strict();

function parseDraft(raw: unknown): StudioDraft {
  const parsed = studioDraftSchema.safeParse(raw);
  if (!parsed.success) throw new StudioError('INVALID_INPUT', [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]);
  return parsed.data;
}

/** Campos que dependen del formato y de la pizarra: se escriben siempre juntos para que una campaña nunca quede con la mitad de otro formato. */
function pricingColumns(draft: StudioDraft, board: StudioBoard, context: StudioContext) {
  if (board.kind === 'BUDGET') {
    return {
      goalCents: board.goalCents,
      costMatCents: draft.costMatCents,
      costInstCents: draft.costInstCents,
      contingencyBps: draft.contingencyBps,
      defaultExemptAppliedCents: board.defaultExemptCents,
      medalExemptAppliedCents: board.medalExemptCents,
      medalRankApplied: board.medalExemptCents > 0 ? context.medalRank : 0,
      bracketRateAppliedBps: board.rateBps,
      bracketFeeCents: board.bracketFeeCents,
      maintFeeCents: board.maintFeeCents,
      gatewayFeeCents: board.gatewayFeeCents,
      ticketSubtype: null,
      ticketPriceCents: null,
      ticketMax: null,
      ticketFeeMode: null,
      ticketVenue: null,
      rafflePrizeCount: null
    };
  }
  return {
    goalCents: board.goalCents,
    costMatCents: 0,
    costInstCents: 0,
    contingencyBps: draft.contingencyBps,
    defaultExemptAppliedCents: 0,
    medalExemptAppliedCents: 0,
    medalRankApplied: 0,
    bracketRateAppliedBps: 0,
    bracketFeeCents: 0,
    maintFeeCents: board.maintFeeCents,
    // En taquilla la pasarela ya la pagan los gastos de gestión digital (cuentas `KORUM_REVENUE_TICKET_FEE` y `GATEWAY_FEES_EXPENSE`): guardarla aquí haría que la
    // liquidación la restara otra vez de la hucha. La pizarra la enseña como coste cubierto, no como parte de la meta (auditoría financiera del 4.3).
    gatewayFeeCents: 0,
    ticketSubtype: draft.ticketSubtype,
    ticketPriceCents: draft.ticketPriceCents,
    ticketMax: draft.ticketMax,
    ticketFeeMode: draft.ticketFeeMode,
    ticketVenue: draft.ticketVenue,
    rafflePrizeCount: draft.ticketSubtype === 'RAFFLE' ? draft.rafflePrizeCount : null
  };
}

/** Lo que no mueve dinero y se puede cambiar con la campaña ya recaudando. */
function softColumns(draft: StudioDraft) {
  return {
    description: draft.description,
    showPublicBreakdown: draft.showPublicBreakdown,
    plaqueEnabled: draft.plaqueEnabled,
    rewardEnabled: draft.rewardEnabled,
    rewardText: draft.rewardEnabled ? draft.rewardText : null,
    targetFamiliesPerCourse: draft.targetFamiliesPerCourse
  };
}

/** 404 uniforme (y rastro del sondeo) si la campaña no es de esta entidad. */
export async function assertOwnedInitiative(db: KorumPrismaClient, actor: SessionActor, organizationId: string, initiativeId: number): Promise<void> {
  const owner = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Initiative', resourceId: initiativeId, resourceLabel: 'Iniciativa', ownerOrganizationId: owner?.organizationId ?? null });
}

async function persistDraft(
  db: Db,
  signer: Extract<SessionActor, { kind: 'user' }>,
  organizationId: string,
  draft: StudioDraft,
  context: StudioContext,
  board: StudioBoard,
  now: Date,
  options: { audit?: boolean } = {}
): Promise<SavedStudioDraft> {
  const audit = options.audit !== false;
  const closesAt = endOfDayInMadrid(draft.closesOn);
  if (!closesAt) throw new StudioError('PROBLEMS', ['CLOSING_INVALID']);
  const category = draft.format === 'TICKETING' ? TICKETING_CATEGORY : draft.category;

  return inTransaction(db, async (tx) => {
    let initiativeId = draft.initiativeId;
    let status: SavedStudioDraft['status'] = 'BUDGETING';
    let created = false;
    let softGoalCents: number | null = null;

    if (initiativeId === null) {
      // Cada campaña es permanente (su hucha y sus enlaces no se borran): un tope de borradores abiertos evita llenar la entidad de basura.
      // La fila de la entidad se bloquea antes de contar: dos creaciones a la vez no pasan las dos con 19 abiertos.
      await tx.organization.updateMany({ where: { id: organizationId }, data: { updatedAt: now } });
      const openDrafts = await tx.initiative.count({ where: { organizationId, status: 'BUDGETING' } });
      if (openDrafts >= MAX_OPEN_DRAFTS) throw new StudioError('TOO_MANY_DRAFTS');
      const initiative = await tx.initiative.create({
        data: {
          walletEscrowId: await allocateWalletId(tx),
          organizationId,
          academicYear: academicYearFor(now),
          title: draft.title,
          category,
          stage: draft.stage,
          status: 'BUDGETING',
          stepIndex: 3,
          closesAt,
          quarter: quarterOf(closesAt),
          format: draft.format,
          ...softColumns(draft),
          ...pricingColumns(draft, board, context),
          createdAt: now
        },
        select: { id: true }
      });
      initiativeId = initiative.id;
      created = true;
    } else {
      // `BUDGETING` primero: la fila queda bloqueada mientras se escribe y una publicación a la vez no se cruza con este guardado.
      const { count } = await tx.initiative.updateMany({
        where: { id: initiativeId, organizationId, status: 'BUDGETING' },
        data: { title: draft.title, category, stage: draft.stage, closesAt, quarter: quarterOf(closesAt), format: draft.format, ...softColumns(draft), ...pricingColumns(draft, board, context) }
      });
      if (count === 0) {
        const current = await tx.initiative.findFirst({
          where: { id: initiativeId, organizationId },
          select: { status: true, format: true, category: true, title: true, goalCents: true, bracketFeeCents: true, bracketRateAppliedBps: true }
        });
        if (!current || current.status !== 'FUNDRAISING' || current.format !== draft.format) throw new StudioError('NOT_EDITABLE', [], initiativeId);
        // Una campaña que se publicó al 0 % no puede cambiar su texto a uno de equipamiento: el candado se pasó con el texto de entonces.
        if (current.format === 'BUDGET' && current.bracketFeeCents === 0 && current.bracketRateAppliedBps === 0 && evaluateStudioLock(context, { category: current.category, title: current.title, description: draft.description }).blocked) {
          // El rastro lo escribe quien llama, fuera de esta transacción: el error la deshace y se llevaría la fila con ella.
          throw new StudioError('SEMANTIC_LOCK', [], initiativeId);
        }
        await tx.initiative.updateMany({ where: { id: initiativeId, organizationId, status: 'FUNDRAISING' }, data: softColumns(draft) });
        status = 'FUNDRAISING';
        softGoalCents = current.goalCents;
      }
    }

    // Con la campaña recaudando solo se guardó lo que no mueve dinero: se registra la meta que sigue valiendo, no la que saldría hoy.
    const goalCents = softGoalCents ?? board.goalCents;
    if (!audit) return { initiativeId, status, goalCents, created };
    const metadata = { initiativeId, format: draft.format, created, goalCents, ...(status === 'BUDGETING' ? {} : { softOnly: true }) };
    await recordAudit(tx, signer, { action: 'studio.initiative_saved', organizationId, targetType: 'Initiative', targetId: String(initiativeId), metadata }, { required: true });
    if (status === 'BUDGETING' && draft.format === 'TICKETING' && draft.ticketSubtype === 'RAFFLE' && draft.raffleNoticeConfirmed) {
      await recordAudit(tx, signer, { action: 'studio.raffle_notice_confirmed', organizationId, targetType: 'Initiative', targetId: String(initiativeId), metadata: { initiativeId, prizes: draft.rafflePrizeCount } }, { required: true });
    }
    if (status === 'BUDGETING' && board.kind === 'BUDGET' && board.categoryExempt) {
      await recordAudit(tx, signer, { action: 'studio.exempt_category_saved', organizationId, targetType: 'Initiative', targetId: String(initiativeId), metadata: { initiativeId, category } }, { required: true });
    }
    if (status === 'BUDGETING' && board.kind === 'BUDGET' && board.lock.blocked) {
      await recordAudit(tx, signer, { action: 'studio.semantic_lock_triggered', organizationId, targetType: 'Initiative', targetId: String(initiativeId), metadata: { initiativeId, category, term: board.lock.term } });
    }
    return { initiativeId, status, goalCents, created };
  });
}

/** Como `persistDraft`, pero deja rastro de un texto que activa el candado en una campaña ya publicada al 0 % (el Super-Admin lo revisa). */
async function persistDraftAudited(db: KorumPrismaClient, signer: Extract<SessionActor, { kind: 'user' }>, organizationId: string, draft: StudioDraft, context: StudioContext, board: StudioBoard, now: Date): Promise<SavedStudioDraft> {
  try {
    return await persistDraft(db, signer, organizationId, draft, context, board, now);
  } catch (error) {
    if (error instanceof StudioError && error.reason === 'SEMANTIC_LOCK' && draft.initiativeId !== null) {
      await recordAudit(db, signer, { action: 'studio.semantic_lock_after_publish', organizationId, targetType: 'Initiative', targetId: String(draft.initiativeId), metadata: { initiativeId: draft.initiativeId, category: draft.category } });
    }
    throw error;
  }
}

/** Guarda el borrador (crea la campaña o actualiza la de `initiativeId`). No publica. */
export async function saveStudioDraft(db: KorumPrismaClient, actor: SessionActor, organizationId: string, raw: unknown, now: Date = new Date()): Promise<SavedStudioDraft> {
  const signer = await requireSigner(db, actor, organizationId, 'studio.save');
  const draft = parseDraft(raw);
  if (draft.initiativeId !== null) await assertOwnedInitiative(db, actor, organizationId, draft.initiativeId);
  const context = await loadFreshStudioContext(db, organizationId, now);
  const problems = saveProblems(context, draft, now);
  if (problems.length > 0) throw new StudioError('PROBLEMS', problems);
  return persistDraftAudited(db, signer, organizationId, draft, context, computeStudioBoard(context, draft), now);
}

/**
 * Guarda y publica (`BUDGETING` → `FUNDRAISING`). El borrador se guarda aunque falte algo para publicar, para no perder lo escrito; entonces responde
 * `BLOCKED` con la lista de lo que falta. Repetir la llamada con la campaña ya publicada no hace nada más que guardar lo permitido.
 */
export async function publishStudioInitiative(db: KorumPrismaClient, actor: SessionActor, organizationId: string, raw: unknown, now: Date = new Date()): Promise<{ initiativeId: number; published: boolean }> {
  const signer = await requireSigner(db, actor, organizationId, 'studio.publish');
  const parsed = publishInputSchema.safeParse(raw);
  if (!parsed.success) throw new StudioError('INVALID_INPUT', [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]);
  const { draft, expectedGoalCents } = parsed.data;
  if (draft.initiativeId !== null) await assertOwnedInitiative(db, actor, organizationId, draft.initiativeId);

  const context = await loadFreshStudioContext(db, organizationId, now);
  const problems = saveProblems(context, draft, now);
  if (problems.length > 0) throw new StudioError('PROBLEMS', problems);
  const board = computeStudioBoard(context, draft);
  const saved = await persistDraftAudited(db, signer, organizationId, draft, context, board, now);
  if (saved.status !== 'BUDGETING') return { initiativeId: saved.initiativeId, published: false };

  const blockers: PublishBlocker[] = publishBlockers(context, draft, board, now);
  if (blockers.length > 0) throw new StudioError('BLOCKED', blockers, saved.initiativeId);
  if (board.goalCents !== expectedGoalCents) throw new StudioError('STALE_BOARD', [], saved.initiativeId);

  try {
    // Lo aceptado se vuelve a escribir y se publica en una sola transacción: la fila queda bloqueada desde el primer momento, así que un guardado de la otra
    // persona firmante no puede cambiar el formato, la rifa o el texto entre la comprobación y la publicación. Si algo falla, el borrador de arriba sigue guardado.
    const accepted: StudioDraft = { ...draft, initiativeId: saved.initiativeId };
    const result = await inTransaction(db, async (tx) => {
      await persistDraft(tx, signer, organizationId, accepted, context, board, now, { audit: false });
      const published = await publishInitiative(tx, saved.initiativeId, now, { expectedGoalCents: board.goalCents });
      if (published.published) {
        await recordAudit(tx, signer, { action: 'studio.initiative_published', organizationId, targetType: 'Initiative', targetId: String(saved.initiativeId), metadata: { initiativeId: saved.initiativeId, format: draft.format, goalCents: board.goalCents } }, { required: true });
      }
      return published;
    });
    return { initiativeId: saved.initiativeId, published: result.published };
  } catch (error) {
    if (error instanceof InsufficientQuotaError || error instanceof QuotaConcurrencyError) throw new StudioError('QUOTA', [], saved.initiativeId);
    if (error instanceof PublishGoalChangedError) throw new StudioError('STALE_BOARD', [], saved.initiativeId);
    if (error instanceof CampaignDurationError) throw new StudioError('BLOCKED', ['CLOSING_TOO_LATE'], saved.initiativeId);
    if (error instanceof InitiativeNotPublishableError) throw new StudioError('NOT_PUBLISHABLE', [error.message], saved.initiativeId);
    throw error;
  }
}

/**
 * Descarta un borrador (PRD §4.1, `BUDGETING` → `CANCELLED`): una campaña sin publicar no ha cobrado ni reservado cupos, así que no hay nada que devolver.
 * Libera su sitio entre los borradores abiertos. Una publicada se cancela por el camino de las liquidaciones y los reembolsos (Sprint 4.4), no desde aquí.
 */
export async function discardStudioDraft(db: KorumPrismaClient, actor: SessionActor, organizationId: string, initiativeId: number): Promise<void> {
  const signer = await requireSigner(db, actor, organizationId, 'studio.discard');
  if (!Number.isSafeInteger(initiativeId) || initiativeId < 1 || initiativeId > 2_147_483_647) throw new StudioError('INVALID_INPUT', ['initiativeId']);
  await assertOwnedInitiative(db, actor, organizationId, initiativeId);
  await inTransaction(db, async (tx) => {
    const { count } = await tx.initiative.updateMany({ where: { id: initiativeId, organizationId, status: 'BUDGETING', raisedCents: 0, quotaReservedAt: null }, data: { status: 'CANCELLED' } });
    if (count === 0) throw new StudioError('NOT_EDITABLE', [], initiativeId);
    await recordAudit(tx, signer, { action: 'studio.draft_discarded', organizationId, targetType: 'Initiative', targetId: String(initiativeId), metadata: { initiativeId } }, { required: true });
  });
}
