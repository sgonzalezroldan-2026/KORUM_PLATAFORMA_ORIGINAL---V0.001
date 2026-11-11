import { parsePollOptions, resizeVoteBlockers, windowDaysLeft, type ExpiredRejection } from '@/core/resize/resize-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { authorizeTenant, type SessionActor } from './tenant-guard';

/**
 * Datos de la pantalla de campañas vencidas (Sprint 4.4b): las que esperan la decisión de la entidad, las que están en votación, las que se están
 * devolviendo (con su progreso) y las ya resueltas (devueltas, o redimensionadas y pendientes de liquidar). Autoriza primero (`DIRECTOR` o `COSIGNER` de
 * **esa** entidad; el Super-Admin entra con registro) y solo lee filas de esa entidad.
 *
 * Mientras la votación está abierta la entidad ve cuántas personas han votado y cuántas pidieron su devolución, **no** cómo va cada opción: así no puede
 * empujar el resultado. El recuento por opción se ve al cerrarse.
 */

export type ExpiredStatus = 'EXPIRED' | 'RESIZE_VOTING' | 'REFUNDING' | 'REFUNDED' | 'GOAL_REACHED' | 'CLOSED';
export type VoteBlocker = Extract<ExpiredRejection, 'NOT_BUDGET' | 'NO_DONATIONS' | 'WINDOW_TOO_SHORT' | 'POLL_EXISTS'>;

export interface RefundProgress {
  total: number;
  done: number;
  totalCents: number;
  doneCents: number;
}

export interface ExpiredCampaignView {
  id: number;
  title: string;
  walletEscrowId: string;
  status: ExpiredStatus;
  raisedCents: number;
  goalCents: number;
  closesAt: string;
  donors: number;
  windowDaysLeft: number | null;
  voteBlockers: VoteBlocker[];
  poll: {
    status: 'OPEN' | 'CLOSED_APPROVED' | 'CLOSED_REJECTED';
    /** Recuento hecho con un proyecto ganador: se está devolviendo su aportación a quien no votó; ya no se vota. */
    tallied: boolean;
    closesAt: string;
    options: string[];
    votes: number;
    refundVotes: number;
    originalGoalCents: number;
    /** Solo con la votación cerrada. */
    counts: number[] | null;
    winner: string | null;
    newGoalCents: number | null;
  } | null;
  refund: RefundProgress | null;
  quotasReleased: boolean;
}

const ACTIVE: ExpiredStatus[] = ['EXPIRED', 'RESIZE_VOTING', 'REFUNDING'];
const HISTORY_LIMIT = 10;

function resultCounts(value: unknown, optionCount: number): number[] | null {
  if (typeof value !== 'object' || value === null || !('counts' in value) || !Array.isArray(value.counts)) return null;
  const counts = value.counts.filter((count): count is number => Number.isSafeInteger(count) && count >= 0);
  return counts.length === optionCount ? counts : null;
}

export async function loadExpiredCampaigns(db: KorumPrismaClient, actor: SessionActor, organizationId: string, now: Date = new Date()): Promise<{ active: ExpiredCampaignView[]; history: ExpiredCampaignView[] }> {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'expired.read', targetType: 'Organization', targetId: organizationId, allowSuperadmin: true });
  const select = {
    id: true,
    title: true,
    walletEscrowId: true,
    status: true,
    format: true,
    raisedCents: true,
    goalCents: true,
    closesAt: true,
    firstPayinAt: true,
    quotaReleasedAt: true,
    resizePoll: { select: { id: true, status: true, closesAt: true, talliedAt: true, optionsJson: true, originalGoalCents: true, winningOptionIndex: true, newGoalCents: true, resultJson: true } }
  } as const;
  const [active, history] = await Promise.all([
    db.initiative.findMany({ where: { organizationId, status: { in: ACTIVE } }, orderBy: [{ closesAt: 'asc' }, { id: 'asc' }], select }),
    db.initiative.findMany({
      where: { organizationId, OR: [{ status: 'REFUNDED', closesAt: { lt: now } }, { status: { in: ['GOAL_REACHED', 'CLOSED'] }, resizePoll: { status: 'CLOSED_APPROVED' } }] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: HISTORY_LIMIT,
      select
    })
  ]);
  const ids = [...active, ...history].map((row) => row.id);
  const pollIds = [...active, ...history].flatMap((row) => (row.resizePoll ? [row.resizePoll.id] : []));
  const [donations, refunds, votes] = await Promise.all([
    db.contribution.groupBy({ by: ['initiativeId'], where: { initiativeId: { in: ids }, type: 'DONATION', status: 'COMPLETED' }, _count: { _all: true } }),
    db.contribution.groupBy({ by: ['initiativeId', 'status'], where: { initiativeId: { in: ids }, type: { in: ['DONATION', 'TICKET'] }, status: { in: ['COMPLETED', 'REFUND_PENDING', 'REFUNDED'] } }, _count: { _all: true }, _sum: { totalChargedCents: true } }),
    db.resizeVote.groupBy({ by: ['pollId', 'wantsRefund'], where: { pollId: { in: pollIds } }, _count: { _all: true } })
  ]);
  const donorsOf = new Map(donations.map((row) => [row.initiativeId, row._count._all]));

  const view = (row: (typeof active)[number]): ExpiredCampaignView => {
    const poll = row.resizePoll;
    const options = poll ? parsePollOptions(poll.optionsJson) : [];
    const pollVotes = poll ? votes.filter((vote) => vote.pollId === poll.id) : [];
    const refundRows = refunds.filter((entry) => entry.initiativeId === row.id);
    const showRefund = row.status === 'REFUNDING' || row.status === 'REFUNDED';
    const sum = (rows: typeof refundRows) => rows.reduce((acc, entry) => ({ count: acc.count + entry._count._all, cents: acc.cents + (entry._sum.totalChargedCents ?? 0) }), { count: 0, cents: 0 });
    const all = sum(refundRows);
    const done = sum(refundRows.filter((entry) => entry.status === 'REFUNDED'));
    const donors = donorsOf.get(row.id) ?? 0;
    return {
      id: row.id,
      title: row.title,
      walletEscrowId: row.walletEscrowId,
      status: row.status as ExpiredStatus,
      raisedCents: row.raisedCents,
      goalCents: row.goalCents,
      closesAt: row.closesAt.toISOString(),
      donors,
      windowDaysLeft: row.firstPayinAt ? windowDaysLeft(row.firstPayinAt, now) : null,
      voteBlockers: row.status === 'EXPIRED' ? resizeVoteBlockers({ format: row.format, firstPayinAt: row.firstPayinAt, donations: donors, hasPoll: poll !== null }, now) : [],
      poll: poll
        ? {
            status: poll.status,
            tallied: poll.status === 'OPEN' && poll.talliedAt !== null,
            closesAt: poll.closesAt.toISOString(),
            options,
            votes: pollVotes.reduce((total, vote) => total + vote._count._all, 0),
            refundVotes: pollVotes.find((vote) => vote.wantsRefund)?._count._all ?? 0,
            originalGoalCents: poll.originalGoalCents,
            counts: poll.status === 'OPEN' && poll.talliedAt === null ? null : resultCounts(poll.resultJson, options.length),
            winner: poll.status !== 'CLOSED_REJECTED' && poll.winningOptionIndex !== null ? (options[poll.winningOptionIndex] ?? null) : null,
            newGoalCents: poll.newGoalCents
          }
        : null,
      refund: showRefund ? { total: all.count, done: done.count, totalCents: all.cents, doneCents: done.cents } : null,
      quotasReleased: row.status === 'REFUNDED' && row.quotaReleasedAt !== null
    };
  };
  return { active: active.map(view), history: history.map(view) };
}
