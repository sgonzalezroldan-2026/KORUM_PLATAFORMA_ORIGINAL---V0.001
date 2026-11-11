import { z } from 'zod';
import { dataHmac, safeEqual } from '@/core/security/data-hmac';
import { RESIZE_MIN_WINDOW_DAYS, RESIZE_OPTION_MAX_LENGTH, RESIZE_OPTION_MIN_LENGTH, RESIZE_OPTIONS_MAX, RESIZE_OPTIONS_MIN, RESIZE_POLL_DAYS } from './resize-limits';

/**
 * Reglas puras de una campaña vencida sin llegar a la meta (Sprint 4.4b, PRD §4.1, decisiones del promotor del 2026-11-11). Sin base de datos.
 *
 * - **Decide la entidad** (una persona firmante con su segundo factor): reembolsar el 100 % (`EXPIRED → REFUNDING`) o lanzar la votación
 *   (`EXPIRED → RESIZE_VOTING`). El cron nunca decide por ella.
 * - **Votación:** votan quienes donaron, **una persona un voto**, durante **7 días**, con 2 a 4 opciones de proyecto escritas por la entidad. Siempre
 *   está además «Prefiero que me devolváis mi aportación»: a quien la elige se le devuelve el 100 % sí o sí (en el acto).
 * - **Resultado:** gana la opción de proyecto más votada. **Sin votos de proyecto o con empate, reembolso a todos.** La meta nueva es lo que queda tras
 *   devolver a quien lo pidió.
 * - Solo campañas de **presupuesto**: un evento o una rifa no tienen versión más pequeña (se reembolsan).
 */

export { hasDuplicateOptions, RESIZE_MIN_WINDOW_DAYS, RESIZE_OPTION_MAX_LENGTH, RESIZE_OPTION_MIN_LENGTH, RESIZE_OPTIONS_MAX, RESIZE_OPTIONS_MIN, RESIZE_POLL_DAYS } from './resize-limits';

const DAY_MS = 86_400_000;

export type ExpiredRejection =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'WRONG_STATUS'
  | 'NOT_BUDGET'
  | 'NO_DONATIONS'
  | 'WINDOW_TOO_SHORT'
  | 'POLL_EXISTS'
  | 'DUPLICATE_OPTIONS'
  | 'RATE_LIMITED';

export class ExpiredCampaignError extends Error {
  readonly reason: ExpiredRejection;

  constructor(reason: ExpiredRejection) {
    super(`La decisión sobre la campaña vencida no se puede tomar: ${reason}.`);
    this.name = 'ExpiredCampaignError';
    this.reason = reason;
  }
}

export type VoteRejection = 'INVALID_LINK' | 'CLOSED' | 'NOT_A_DONOR' | 'ALREADY_VOTED' | 'INVALID_CHOICE' | 'RATE_LIMITED';

export class ResizeVoteError extends Error {
  readonly reason: VoteRejection;

  constructor(reason: VoteRejection) {
    super(`El voto no se puede registrar: ${reason}.`);
    this.name = 'ResizeVoteError';
    this.reason = reason;
  }
}

const initiativeId = z.number().int().positive().max(2_147_483_647);
/** Una línea sin caracteres de control ni de dirección de texto: la opción se lee igual en el email, en la página de voto y en el panel. */
const optionText = z
  .string()
  .max(RESIZE_OPTION_MAX_LENGTH * 2)
  .transform((value) => value.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(RESIZE_OPTION_MIN_LENGTH).max(RESIZE_OPTION_MAX_LENGTH));

export const decideRefundSchema = z.object({ initiativeId }).strict();
export const launchResizeVoteSchema = z.object({ initiativeId, options: z.array(optionText).min(RESIZE_OPTIONS_MIN).max(RESIZE_OPTIONS_MAX) }).strict();
export type LaunchResizeVoteInput = z.infer<typeof launchResizeVoteSchema>;

export const resizeVoteChoiceSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('OPTION'), index: z.number().int().min(0).max(RESIZE_OPTIONS_MAX - 1) }).strict(), z.object({ kind: z.literal('REFUND') }).strict()]);
export type ResizeVoteChoice = z.infer<typeof resizeVoteChoiceSchema>;
export const castResizeVoteSchema = z.object({ orgSlug: z.string().min(1).max(80), token: z.string().min(10).max(120), choice: resizeVoteChoiceSchema }).strict();

/** Las opciones guardadas en la votación (`optionsJson`): una lista de textos. Una fila que no lo sea no se enseña ni se cuenta. */
export function parsePollOptions(value: unknown): string[] {
  const parsed = z.array(z.string().max(RESIZE_OPTION_MAX_LENGTH)).max(RESIZE_OPTIONS_MAX).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** ¿Se puede lanzar la votación? Lo que lo impide, en el orden en que la entidad lo entiende. La reserva de la ventana se mide desde el primer cobro. */
export function resizeVoteBlockers(initiative: { format: string; firstPayinAt: Date | null; donations: number; hasPoll: boolean }, now: Date): Array<Extract<ExpiredRejection, 'NOT_BUDGET' | 'NO_DONATIONS' | 'WINDOW_TOO_SHORT' | 'POLL_EXISTS'>> {
  const blockers: Array<Extract<ExpiredRejection, 'NOT_BUDGET' | 'NO_DONATIONS' | 'WINDOW_TOO_SHORT' | 'POLL_EXISTS'>> = [];
  if (initiative.hasPoll) blockers.push('POLL_EXISTS');
  if (initiative.format !== 'BUDGET') blockers.push('NOT_BUDGET');
  if (initiative.donations === 0) blockers.push('NO_DONATIONS');
  if (initiative.firstPayinAt && windowDaysLeft(initiative.firstPayinAt, now) < RESIZE_MIN_WINDOW_DAYS) blockers.push('WINDOW_TOO_SHORT');
  return blockers;
}

/** Días que quedan de la ventana de 90 días de Paycomet desde el primer cobro, redondeando hacia abajo. */
export function windowDaysLeft(firstPayinAt: Date, now: Date): number {
  return Math.max(0, Math.floor((firstPayinAt.getTime() + 90 * DAY_MS - now.getTime()) / DAY_MS));
}

export const pollClosesAt = (now: Date): Date => new Date(now.getTime() + RESIZE_POLL_DAYS * DAY_MS);

export type ResizeOutcome = 'PROJECT' | 'NO_VOTES' | 'TIE';

export interface ResizeTally {
  counts: number[];
  refundVotes: number;
  outcome: ResizeOutcome;
  winningOptionIndex: number | null;
}

/** Recuento: solo los votos de proyecto compiten; los de devolución no son una opción, son el derecho de cada persona a recuperar lo suyo. */
export function tallyResizeVotes(votes: ReadonlyArray<{ optionIndex: number | null; wantsRefund: boolean }>, optionCount: number): ResizeTally {
  const counts = Array.from({ length: optionCount }, () => 0);
  let refundVotes = 0;
  for (const vote of votes) {
    if (vote.wantsRefund) refundVotes += 1;
    else if (vote.optionIndex !== null && vote.optionIndex >= 0 && vote.optionIndex < optionCount) counts[vote.optionIndex] = (counts[vote.optionIndex] ?? 0) + 1;
  }
  const best = Math.max(0, ...counts);
  if (best === 0) return { counts, refundVotes, outcome: 'NO_VOTES', winningOptionIndex: null };
  const leaders = counts.flatMap((count, index) => (count === best ? [index] : []));
  if (leaders.length !== 1) return { counts, refundVotes, outcome: 'TIE', winningOptionIndex: null };
  return { counts, refundVotes, outcome: 'PROJECT', winningOptionIndex: leaders[0] ?? null };
}

/**
 * Enlace personal de voto (`?v=`): la votación y la donación desde la que se vota, firmados con `DATA_HMAC_SECRET` y dominio propio. No abre nada más que
 * la papeleta de esa persona; vale mientras la votación esté abierta. Va en el email (campo secreto, se borra de la bandeja al enviarlo), nunca en claro
 * en la base de datos.
 */
const TOKEN_PATTERN = /^([1-9]\d{0,9})\.([1-9]\d{0,9})\.([0-9a-f]{64})$/;
const TOKEN_PURPOSE = 'resize-vote:v1';

export function signResizeVoteToken(secret: string, pollId: number, contributionId: number): string {
  const payload = `${pollId}.${contributionId}`;
  return `${payload}.${dataHmac(secret, TOKEN_PURPOSE, payload)}`;
}

export function readResizeVoteToken(secret: string, token: string): { pollId: number; contributionId: number } | null {
  const match = TOKEN_PATTERN.exec(token);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const payload = `${match[1]}.${match[2]}`;
  if (!safeEqual(dataHmac(secret, TOKEN_PURPOSE, payload), match[3])) return null;
  const pollId = Number(match[1]);
  const contributionId = Number(match[2]);
  return Number.isSafeInteger(pollId) && Number.isSafeInteger(contributionId) && pollId <= 2_147_483_647 && contributionId <= 2_147_483_647 ? { pollId, contributionId } : null;
}
