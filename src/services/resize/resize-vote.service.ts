import { castResizeVoteSchema, parsePollOptions, readResizeVoteToken, ResizeVoteError, type ResizeVoteChoice } from '@/core/resize/resize-rules';
import { hashIpSubnet } from '@/core/security/device-signals';
import { inTransaction, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { RESIZE_VOTE_RULE } from '@/lib/rate-limit-rules';
import { DONOR_RECIPIENT_SELECT, donorCandidatesWhere, donorRecipient } from '@/services/notifications/donor-recipient';
import { approveRefundInTx } from '@/services/payments/payment-reversals';

/**
 * La papeleta de quien donó a una campaña vencida (Sprint 4.4b, decisión del promotor del 2026-11-11). Se llega desde el enlace personal del email
 * (`/{entidad}/votacion?v=`), sin cuenta: el enlace firma la votación y una donación, y de la donación sale la persona (su email canónico).
 *
 * - **Una persona, un voto**, aunque donara varias veces o tenga varios enlaces: el voto es por email canónico y no cambia.
 * - **«Prefiero que me devolváis mi aportación»** devuelve en el acto el 100 % de **todas** sus donaciones a esa campaña (también la aportación voluntaria
 *   a KORUM), al medio de pago original: se aprueba aquí y la tarea `MASS_REFUND` la envía a Paycomet. Deja de contar en lo recaudado al momento, así que
 *   la meta nueva sale sola de lo que queda.
 * - Solo vota quien aún tiene alguna donación completada en la campaña (una devuelta o con contracargo ya no es una aportación).
 * - El voto y el cierre bloquean la misma fila (la iniciativa): un voto nunca entra después del recuento.
 */

export type BallotView =
  | { status: 'INVALID' }
  | {
      status: 'OPEN' | 'CLOSED';
      title: string;
      walletEscrowId: string;
      organizationName: string;
      options: string[];
      closesAt: Date;
      raisedCents: number;
      originalGoalCents: number;
      /** Lo que se le devolvería a esta persona (el 100 % de lo que pagó en sus donaciones aún completadas). */
      refundableCents: number;
      vote: ResizeVoteChoice | null;
      /** Con la votación cerrada: la opción ganadora, o `null` si se devuelve a todas las personas. */
      winner: string | null;
    };

/** La donación del enlace con lo necesario para saber quién vota y en qué votación; `null` si el enlace no casa. */
async function loadLinkedDonation(db: Db, secret: string, orgSlug: string, token: string) {
  const parsed = readResizeVoteToken(secret, token);
  if (!parsed) return null;
  const contribution = await db.contribution.findUnique({
    where: { id: parsed.contributionId },
    select: { id: true, type: true, initiativeId: true, organization: { select: { slug: true, name: true } }, ...DONOR_RECIPIENT_SELECT }
  });
  if (!contribution || contribution.type !== 'DONATION' || contribution.organization.slug !== orgSlug) return null;
  const poll = await db.resizePoll.findUnique({
    where: { id: parsed.pollId },
    select: { id: true, initiativeId: true, status: true, closesAt: true, talliedAt: true, optionsJson: true, originalGoalCents: true, winningOptionIndex: true, initiative: { select: { status: true, title: true, walletEscrowId: true, raisedCents: true } } }
  });
  const recipient = donorRecipient(contribution);
  if (!poll || poll.initiativeId !== contribution.initiativeId || !recipient) return null;
  return { contribution, poll, canonical: recipient.canonical };
}

/** Las donaciones aún completadas de esta persona en la campaña (las que votan y las que se le devolverían). */
async function donationsOf(db: Db, initiativeId: number, canonical: string) {
  const rows = await db.contribution.findMany({
    where: { initiativeId, type: 'DONATION', status: 'COMPLETED', ...donorCandidatesWhere(canonical) },
    orderBy: { id: 'asc' },
    select: { id: true, totalChargedCents: true, ...DONOR_RECIPIENT_SELECT }
  });
  return rows.filter((row) => donorRecipient(row)?.canonical === canonical);
}

const isOpen = (poll: { status: string; closesAt: Date; talliedAt: Date | null; initiative: { status: string } }, now: Date) => poll.status === 'OPEN' && poll.talliedAt === null && poll.closesAt > now && poll.initiative.status === 'RESIZE_VOTING';

export async function loadResizeBallot(db: KorumPrismaClient, secret: string, orgSlug: string, token: string, now: Date = new Date()): Promise<BallotView> {
  const linked = await loadLinkedDonation(db, secret, orgSlug, token);
  if (!linked) return { status: 'INVALID' };
  const { poll, contribution, canonical } = linked;
  const options = parsePollOptions(poll.optionsJson);
  const [vote, donations] = await Promise.all([db.resizeVote.findUnique({ where: { pollId_canonicalEmail: { pollId: poll.id, canonicalEmail: canonical } }, select: { optionIndex: true, wantsRefund: true } }), donationsOf(db, poll.initiativeId, canonical)]);
  return {
    status: isOpen(poll, now) ? 'OPEN' : 'CLOSED',
    title: poll.initiative.title,
    walletEscrowId: poll.initiative.walletEscrowId,
    organizationName: contribution.organization.name,
    options,
    closesAt: poll.closesAt,
    raisedCents: poll.initiative.raisedCents,
    originalGoalCents: poll.originalGoalCents,
    refundableCents: donations.reduce((sum, row) => sum + row.totalChargedCents, 0),
    vote: vote ? (vote.wantsRefund ? { kind: 'REFUND' } : { kind: 'OPTION', index: vote.optionIndex ?? 0 }) : null,
    // Ganó un proyecto ya en el recuento (aunque aún se esté devolviendo a quien no votó).
    winner: poll.status !== 'CLOSED_REJECTED' && poll.winningOptionIndex !== null ? (options[poll.winningOptionIndex] ?? null) : null
  };
}

export interface VoteReceipt {
  choice: ResizeVoteChoice;
  refundedCents: number;
}

/** Registra el voto (y, si pide la devolución, la aprueba en la misma transacción). Lanza `ResizeVoteError` con el motivo si no se puede. */
export async function castResizeVote(db: KorumPrismaClient, secret: string, payload: unknown, context: { ip: string | null }, now: Date = new Date()): Promise<VoteReceipt> {
  const parsed = castResizeVoteSchema.safeParse(payload);
  if (!parsed.success) throw new ResizeVoteError('INVALID_CHOICE');
  const input = parsed.data;
  // Un enlace mal formado o sin firma válida no toca la base ni gasta intentos de la red (el wifi del colegio lo comparten muchas familias).
  if (!readResizeVoteToken(secret, input.token)) throw new ResizeVoteError('INVALID_LINK');
  if (!(await reserveAttempt(db, `${RESIZE_VOTE_RULE.prefix}${hashIpSubnet(secret, context.ip)}`, RESIZE_VOTE_RULE, now))) throw new ResizeVoteError('RATE_LIMITED');

  return inTransaction(db, async (tx) => {
    const reference = await loadLinkedDonation(tx, secret, input.orgSlug, input.token);
    if (!reference) throw new ResizeVoteError('INVALID_LINK');
    // Bloquea la iniciativa y vuelve a leer: el cierre de la votación, un cobro tardío o un contracargo esperan a que termine el voto.
    await tx.initiative.updateMany({ where: { id: reference.poll.initiativeId }, data: { ticketsHeld: { increment: 0 } } });
    const linked = await loadLinkedDonation(tx, secret, input.orgSlug, input.token);
    if (!linked) throw new ResizeVoteError('INVALID_LINK');
    const { poll, canonical } = linked;
    if (!isOpen(poll, now)) throw new ResizeVoteError('CLOSED');
    const options = parsePollOptions(poll.optionsJson);
    if (input.choice.kind === 'OPTION' && input.choice.index >= options.length) throw new ResizeVoteError('INVALID_CHOICE');
    if (await tx.resizeVote.findUnique({ where: { pollId_canonicalEmail: { pollId: poll.id, canonicalEmail: canonical } }, select: { id: true } })) throw new ResizeVoteError('ALREADY_VOTED');
    const donations = await donationsOf(tx, poll.initiativeId, canonical);
    if (donations.length === 0) throw new ResizeVoteError('NOT_A_DONOR');

    const wantsRefund = input.choice.kind === 'REFUND';
    await tx.resizeVote.create({ data: { pollId: poll.id, canonicalEmail: canonical, contributionId: linked.contribution.id, wantsRefund, optionIndex: input.choice.kind === 'OPTION' ? input.choice.index : null, createdAt: now } });
    let refundedCents = 0;
    if (wantsRefund) {
      for (const donation of donations) {
        await approveRefundInTx(tx, donation.id, { at: now });
        refundedCents += donation.totalChargedCents;
      }
    }
    const organizationId = (await tx.initiative.findUniqueOrThrow({ where: { id: poll.initiativeId }, select: { organizationId: true } })).organizationId;
    // Sin email, nombre ni donación: en la auditoría queda qué se eligió y qué se devolvió, no quién (la auditoría no se anonimiza).
    await tx.auditLog.create({
      data: { actorType: 'SYSTEM', organizationId, action: wantsRefund ? 'resize.vote_refund' : 'resize.vote_option', targetType: 'ResizePoll', targetId: String(poll.id), metadataJson: { donations: donations.length, refundedCents, ...(input.choice.kind === 'OPTION' ? { optionIndex: input.choice.index } : {}) } }
    });
    return { choice: input.choice, refundedCents };
  });
}
