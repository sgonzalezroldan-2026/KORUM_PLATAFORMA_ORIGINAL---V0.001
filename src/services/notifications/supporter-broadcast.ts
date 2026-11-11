import { parsePollOptions, signResizeVoteToken } from '@/core/resize/resize-rules';
import { dataHmac } from '@/core/security/data-hmac';
import type { Prisma } from '@/generated/prisma/client';
import { inTransaction, type Db } from '@/lib/db';
import { DONOR_RECIPIENT_SELECT, donorRecipient } from './donor-recipient';

/**
 * Avisos a quienes aportaron a una iniciativa (Sprint 4.4a, heredado del 3.6): «¡Lo hemos conseguido!» al llegar al 100 % y «Mirad cómo ha quedado» con
 * las fotos Antes / Después. Un reparto a miles de familias no cabe en la transacción de un cobro: quien provoca el aviso solo deja una fila
 * (`SupporterBroadcast`, una por iniciativa y plantilla) y la tarea `SUPPORTER_BROADCAST` la reparte por lotes, siguiendo desde la última aportación tratada.
 *
 * - Solo a quien **donó**: donaciones `COMPLETED` (no devueltas ni contracargadas). Ni entradas ni papeletas, ni comercios, ni el Auto-Impulso.
 * - Una vez por persona e iniciativa aunque aportara varias veces: la clave de la bandeja lleva el HMAC de su email canónico, no el email.
 * - Al email de su cuenta (si no está anonimizada) o al de invitado, en el idioma con el que aportó.
 * - Son avisos sobre el destino de su propia donación (la garantía «todo o nada»), no publicidad: no piden `MARKETING_EMAILS` (punto para el abogado,
 *   CUMPLIMIENTO §9).
 *
 * Sprint 4.4b, campañas vencidas: la **votación** (`initiative.resizePoll`, con el enlace personal de voto de cada persona, que es un campo secreto del
 * mensaje), su **resultado** cuando gana un proyecto (`initiative.resizeResult`, solo a quien no pidió que le devolvieran lo suyo) y el **aviso de
 * reembolso** (`initiative.refundingSupporter`, también a quien ya tiene la devolución en marcha). Cada una solo sale mientras la campaña sigue en el
 * estado que la justifica; si no, se descarta.
 */

export const SUPPORTER_TEMPLATES = ['initiative.goalReachedSupporter', 'initiative.achievementPhotos', 'initiative.resizePoll', 'initiative.resizeResult', 'initiative.refundingSupporter'] as const;
export type SupporterTemplate = (typeof SUPPORTER_TEMPLATES)[number];

/** A qué donaciones llega cada aviso: el de reembolso, también a las que ya se están devolviendo (el dinero aún no ha llegado). */
const RECIPIENT_STATUSES: Record<SupporterTemplate, Array<'COMPLETED' | 'REFUND_PENDING' | 'REFUNDED'>> = {
  'initiative.goalReachedSupporter': ['COMPLETED'],
  'initiative.achievementPhotos': ['COMPLETED'],
  'initiative.resizePoll': ['COMPLETED'],
  'initiative.resizeResult': ['COMPLETED'],
  'initiative.refundingSupporter': ['COMPLETED', 'REFUND_PENDING', 'REFUNDED']
};

const isSupporterTemplate = (key: string): key is SupporterTemplate => (SUPPORTER_TEMPLATES as readonly string[]).includes(key);

/** Deja el aviso pendiente (en la transacción de quien llama). Repetirlo no hace nada: hay uno por iniciativa y plantilla. */
export async function queueSupporterBroadcast(tx: Db, initiativeId: number, templateKey: SupporterTemplate, now: Date): Promise<void> {
  await tx.supporterBroadcast.createMany({ data: [{ initiativeId, templateKey, createdAt: now }], skipDuplicates: true });
}

/** Con las dos fotos publicadas y la iniciativa cerrada (liquidación hecha), se avisa una vez con el Antes y el Después. */
export async function queuePhotosBroadcastIfReady(tx: Db, initiativeId: number, now: Date): Promise<boolean> {
  const initiative = await tx.initiative.findUnique({ where: { id: initiativeId }, select: { status: true, beforeFileId: true, afterFileId: true } });
  if (!initiative || initiative.status !== 'CLOSED' || !initiative.beforeFileId || !initiative.afterFileId) return false;
  await queueSupporterBroadcast(tx, initiativeId, 'initiative.achievementPhotos', now);
  return true;
}

interface BroadcastRun {
  now: Date;
  batchSize: number;
  deadline?: number;
  hmacSecret: string;
}

type PollForBroadcast = { id: number; status: string; closesAt: Date; optionsJson: unknown; winningOptionIndex: number | null; newGoalCents: number | null } | null;

/**
 * ¿Sigue teniendo sentido el aviso? `WAIT`: aún no (la campaña volvió a recaudar); `DROP`: ya no (se descarta). La votación solo se reparte mientras está
 * abierta: un enlace que llega cerrado no sirve.
 */
function readiness(templateKey: SupporterTemplate, status: string, poll: PollForBroadcast, now: Date): 'SEND' | 'WAIT' | 'DROP' {
  switch (templateKey) {
    case 'initiative.goalReachedSupporter':
      // «¡Lo hemos conseguido!» solo con la meta conseguida: si un contracargo la devolvió a recaudar, espera; si acabó sin lograrla, se descarta (M3 del 4.4a).
      // Una campaña redimensionada tiene su propio aviso (el resultado de la votación).
      if ((status === 'GOAL_REACHED' || status === 'CLOSED') && !poll) return 'SEND';
      return poll || ['EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED', 'CANCELLED'].includes(status) ? 'DROP' : 'WAIT';
    case 'initiative.achievementPhotos':
      return 'SEND';
    case 'initiative.resizePoll':
      return status === 'RESIZE_VOTING' && poll?.status === 'OPEN' && poll.closesAt > now ? 'SEND' : 'DROP';
    case 'initiative.resizeResult':
      return (status === 'GOAL_REACHED' || status === 'CLOSED') && poll?.status === 'CLOSED_APPROVED' ? 'SEND' : 'DROP';
    case 'initiative.refundingSupporter':
      return status === 'REFUNDING' || status === 'REFUNDED' ? 'SEND' : 'DROP';
  }
}

/** Lo que añade cada aviso a su mensaje: la votación lleva el enlace personal (firmado con la donación desde la que se vota); el resultado, lo que ganó. */
function extraPayload(templateKey: SupporterTemplate, poll: PollForBroadcast, contributionId: number, secret: string): Prisma.InputJsonObject {
  if (!poll) return {};
  // El enlace es un secreto de la bandeja: vale hasta el cierre de la votación (sin `expiresAt`, la bandeja lo daría por caducado a la hora).
  if (templateKey === 'initiative.resizePoll') return { pollId: poll.id, closesAt: poll.closesAt.toISOString(), expiresAt: poll.closesAt.toISOString(), voteToken: signResizeVoteToken(secret, poll.id, contributionId) };
  if (templateKey === 'initiative.resizeResult' && poll.winningOptionIndex !== null && poll.newGoalCents !== null) {
    return { option: parsePollOptions(poll.optionsJson)[poll.winningOptionIndex] ?? '', newGoalCents: poll.newGoalCents };
  }
  return {};
}

/** Trata un lote de una difusión pendiente: escribe sus mensajes en la bandeja y avanza el cursor en la misma transacción. */
async function advance(db: Db, broadcastId: number, run: BroadcastRun): Promise<{ queued: number; done: boolean }> {
  return inTransaction(db, async (tx) => {
    // Bloquea la fila: dos ejecuciones a la vez no tratan el mismo lote (y aunque lo hicieran, la clave de la bandeja no lo duplicaría).
    const broadcast = await tx.supporterBroadcast.update({ where: { id: broadcastId }, data: { cursorId: { increment: 0 } }, select: { id: true, initiativeId: true, templateKey: true, cursorId: true, completedAt: true } });
    if (broadcast.completedAt) return { queued: 0, done: true };
    const initiative = await tx.initiative.findUniqueOrThrow({
      where: { id: broadcast.initiativeId },
      select: { id: true, organizationId: true, walletEscrowId: true, status: true, resizePoll: { select: { id: true, status: true, closesAt: true, optionsJson: true, winningOptionIndex: true, newGoalCents: true } } }
    });
    const templateKey = broadcast.templateKey;
    const state = isSupporterTemplate(templateKey) ? readiness(templateKey, initiative.status, initiative.resizePoll, run.now) : 'DROP';
    if (state !== 'SEND' || !isSupporterTemplate(templateKey)) {
      if (state === 'DROP') await tx.supporterBroadcast.update({ where: { id: broadcast.id }, data: { completedAt: run.now } });
      return { queued: 0, done: true };
    }
    const rows = await tx.contribution.findMany({
      where: { initiativeId: broadcast.initiativeId, type: 'DONATION', status: { in: RECIPIENT_STATUSES[templateKey] }, id: { gt: broadcast.cursorId } },
      orderBy: { id: 'asc' },
      take: run.batchSize,
      select: { id: true, locale: true, ...DONOR_RECIPIENT_SELECT }
    });
    const data = rows.flatMap((row) => {
      const recipient = donorRecipient(row);
      if (!recipient) return [];
      return [
        {
          idempotencyKey: `${templateKey}:${initiative.id}:${dataHmac(run.hmacSecret, 'supporter-notice', recipient.canonical)}`,
          templateKey,
          locale: row.locale,
          toAddress: recipient.toAddress,
          organizationId: initiative.organizationId,
          payloadJson: { initiativeId: initiative.id, walletEscrowId: initiative.walletEscrowId, ...extraPayload(templateKey, initiative.resizePoll, row.id, run.hmacSecret) }
        }
      ];
    });
    const { count } = data.length > 0 ? await tx.outboxMessage.createMany({ data, skipDuplicates: true }) : { count: 0 };
    const last = rows[rows.length - 1];
    const done = rows.length < run.batchSize;
    await tx.supporterBroadcast.update({
      where: { id: broadcast.id },
      data: { cursorId: last?.id ?? broadcast.cursorId, queuedCount: { increment: count }, ...(done ? { completedAt: run.now } : {}) }
    });
    return { queued: count, done };
  });
}

/**
 * Tarea `SUPPORTER_BROADCAST`: recorre las difusiones pendientes, la más antigua primero, lote a lote, hasta acabarlas o hasta el límite de tiempo de la
 * función. Lo que quede lo recoge la siguiente ejecución desde su cursor.
 */
export async function runSupporterBroadcasts(db: Db, run: BroadcastRun): Promise<{ processed: number; queued: number; hasMore: boolean }> {
  // Las de «¡Lo hemos conseguido!» de una campaña que volvió a recaudar esperan sin ocupar el sitio de las demás: se recorren todas por páginas.
  const ready = { completedAt: null, NOT: { templateKey: 'initiative.goalReachedSupporter', initiative: { status: 'FUNDRAISING' as const } } };
  let processed = 0;
  let queued = 0;
  let cursor = 0;
  for (;;) {
    const page = await db.supporterBroadcast.findMany({ where: { ...ready, id: { gt: cursor } }, orderBy: { id: 'asc' }, take: 50, select: { id: true } });
    for (const { id } of page) {
      for (;;) {
        if (run.deadline !== undefined && Date.now() > run.deadline) return { processed, queued, hasMore: true };
        const step = await advance(db, id, run);
        queued += step.queued;
        if (step.done) break;
      }
      processed += 1;
    }
    const last = page[page.length - 1];
    if (!last || page.length < 50) return { processed, queued, hasMore: false };
    cursor = last.id;
  }
}

/**
 * Reparte ya, sin esperar a la tarea, la difusión de una iniciativa y plantilla (Sprint 4.4b: la votación dura 7 días y en el plan gratuito la tarea corre
 * una vez al día). Hasta el límite de tiempo; lo que falte sigue en la tarea desde su cursor, sin repetir a nadie.
 */
export async function advanceSupporterBroadcastNow(db: Db, initiativeId: number, templateKey: SupporterTemplate, run: BroadcastRun): Promise<number> {
  const broadcast = await db.supporterBroadcast.findUnique({ where: { initiativeId_templateKey: { initiativeId, templateKey } }, select: { id: true, completedAt: true } });
  if (!broadcast || broadcast.completedAt) return 0;
  let queued = 0;
  for (;;) {
    if (run.deadline !== undefined && Date.now() > run.deadline) return queued;
    const step = await advance(db, broadcast.id, run);
    queued += step.queued;
    if (step.done) return queued;
  }
}
