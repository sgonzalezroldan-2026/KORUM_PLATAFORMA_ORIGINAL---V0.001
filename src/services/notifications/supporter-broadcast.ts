import { dataHmac } from '@/core/security/data-hmac';
import { normalizeCanonicalEmail } from '@/core/security/email-normalizer';
import { inTransaction, type Db } from '@/lib/db';

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
 */

export const SUPPORTER_TEMPLATES = ['initiative.goalReachedSupporter', 'initiative.achievementPhotos'] as const;
export type SupporterTemplate = (typeof SUPPORTER_TEMPLATES)[number];

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

/** Email canónico (sin alias `+` ni puntos de Gmail) de una fila antigua que no lo guardó; uno que no se puede normalizar no recibe aviso. */
function canonicalOf(address: string | null): string | null {
  if (!address) return null;
  try {
    return normalizeCanonicalEmail(address);
  } catch {
    return null;
  }
}

interface BroadcastRun {
  now: Date;
  batchSize: number;
  deadline?: number;
  hmacSecret: string;
}

/** Trata un lote de una difusión pendiente: escribe sus mensajes en la bandeja y avanza el cursor en la misma transacción. */
async function advance(db: Db, broadcastId: number, run: BroadcastRun): Promise<{ queued: number; done: boolean }> {
  return inTransaction(db, async (tx) => {
    // Bloquea la fila: dos ejecuciones a la vez no tratan el mismo lote (y aunque lo hicieran, la clave de la bandeja no lo duplicaría).
    const broadcast = await tx.supporterBroadcast.update({ where: { id: broadcastId }, data: { cursorId: { increment: 0 } }, select: { id: true, initiativeId: true, templateKey: true, cursorId: true, completedAt: true } });
    if (broadcast.completedAt) return { queued: 0, done: true };
    const initiative = await tx.initiative.findUniqueOrThrow({ where: { id: broadcast.initiativeId }, select: { id: true, organizationId: true, walletEscrowId: true, status: true } });
    // «¡Lo hemos conseguido!» solo con la meta conseguida: si un contracargo la devolvió a recaudar, espera; si la campaña acabó sin lograrla, se descarta
    // (auditoría financiera del 4.4a, M3).
    if (broadcast.templateKey === 'initiative.goalReachedSupporter' && initiative.status !== 'GOAL_REACHED' && initiative.status !== 'CLOSED') {
      const lost = ['EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED', 'CANCELLED'].includes(initiative.status);
      if (lost) await tx.supporterBroadcast.update({ where: { id: broadcast.id }, data: { completedAt: run.now } });
      return { queued: 0, done: true };
    }
    const rows = await tx.contribution.findMany({
      where: { initiativeId: broadcast.initiativeId, type: 'DONATION', status: 'COMPLETED', id: { gt: broadcast.cursorId } },
      orderBy: { id: 'asc' },
      take: run.batchSize,
      select: { id: true, guestEmail: true, canonicalEmail: true, locale: true, user: { select: { email: true, canonicalEmail: true, gdprAnonymizedAt: true } } }
    });
    const data = rows.flatMap((row) => {
      const account = row.user && !row.user.gdprAnonymizedAt ? row.user : null;
      const toAddress = row.guestEmail ?? account?.email ?? null;
      const canonical = row.canonicalEmail ?? account?.canonicalEmail ?? canonicalOf(toAddress);
      if (!toAddress || !canonical || canonical.startsWith('anonimizado:')) return [];
      return [
        {
          idempotencyKey: `${broadcast.templateKey}:${initiative.id}:${dataHmac(run.hmacSecret, 'supporter-notice', canonical)}`,
          templateKey: broadcast.templateKey,
          locale: row.locale,
          toAddress,
          organizationId: initiative.organizationId,
          payloadJson: { initiativeId: initiative.id, walletEscrowId: initiative.walletEscrowId }
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
