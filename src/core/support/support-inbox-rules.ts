import { z } from 'zod';
import { cleanIdeaText } from '@/core/ideas/idea-rules';
import { cleanSupportText, isTicketCode, SUPPORT_MESSAGE_MAX, SUPPORT_MESSAGE_MIN, SUPPORT_SUBJECT_MAX, SUPPORT_SUBJECT_MIN } from './support-rules';

/**
 * Reglas puras de la bandeja de soporte del centro (Sprint 4.4c, prototipo `id="sch-sub-support"`): quién puede contestar qué, cómo avanza el estado y
 * qué puede escribir la entidad a KORUM. Sin base de datos.
 *
 * - **Una sola respuesta por consulta.** El centro contesta una vez (`replyMessage`) y la familia lo ve en *Mi cuenta*; si hace falta seguir, la
 *   familia escribe otra consulta. Así un email de aviso no se repite y no hay un hilo que nadie vigila.
 * - **El estado solo avanza:** `OPEN → IN_PROGRESS → RESOLVED`. Una consulta resuelta ya no se toca (su plazo de conservación corre desde que se cierra).
 * - Contestar sin elegir estado pasa la consulta a «en curso» si estaba abierta.
 */

export const REPLY_MIN = 5;
export const REPLY_MAX = SUPPORT_MESSAGE_MAX;

export type InboxStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
export type InboxTargetStatus = Exclude<InboxStatus, 'OPEN'>;

export const INBOX_STATUS_ORDER: readonly InboxStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];

/** Un campo vacío del formulario es «no lo toco», no un texto vacío que falle la validación. */
const optionalText = (min: number, max: number) =>
  z
    .string()
    .transform(cleanSupportText)
    .pipe(z.string().max(max))
    .transform((value) => (value === '' ? undefined : value))
    .pipe(z.string().min(min).optional())
    .optional();

export const answerTicketSchema = z
  .object({
    ticketCode: z.string().refine(isTicketCode),
    reply: optionalText(REPLY_MIN, REPLY_MAX),
    status: z.enum(['IN_PROGRESS', 'RESOLVED']).optional()
  })
  .strict()
  .refine((value) => value.reply !== undefined || value.status !== undefined);
export type AnswerTicketInput = z.infer<typeof answerTicketSchema>;

/** Temas con los que la entidad escribe a KORUM: sobre una campaña, un pago o una liquidación, la cuenta o cualquier otra cosa. */
export const ENTITY_TOPICS = ['INITIATIVE', 'PAYMENT', 'ACCOUNT', 'OTHER'] as const;

export const entityMessageSchema = z
  .object({
    topic: z.enum(ENTITY_TOPICS),
    subject: z.string().transform(cleanIdeaText).pipe(z.string().min(SUPPORT_SUBJECT_MIN).max(SUPPORT_SUBJECT_MAX)),
    message: z.string().transform(cleanSupportText).pipe(z.string().min(SUPPORT_MESSAGE_MIN).max(SUPPORT_MESSAGE_MAX))
  })
  .strict();
export type EntityMessageInput = z.infer<typeof entityMessageSchema>;

export type AnswerRejection = 'INVALID_INPUT' | 'NOT_FOUND' | 'ALREADY_RESOLVED' | 'ALREADY_REPLIED' | 'NOTHING_TO_CHANGE' | 'CONFLICT' | 'PURGED';

export type AnswerPlan = { ok: true; nextStatus: InboxStatus; reply: string | null } | { ok: false; reason: Extract<AnswerRejection, 'ALREADY_RESOLVED' | 'ALREADY_REPLIED' | 'NOTHING_TO_CHANGE'> };

/** Qué pasa si la entidad pide `request` sobre una consulta que está en `current`. El estado nunca retrocede y una consulta contestada no se contesta dos veces. */
export function planTicketAnswer(current: { status: InboxStatus; hasReply: boolean }, request: { reply?: string; status?: InboxTargetStatus }): AnswerPlan {
  if (current.status === 'RESOLVED') return { ok: false, reason: 'ALREADY_RESOLVED' };
  if (request.reply !== undefined && current.hasReply) return { ok: false, reason: 'ALREADY_REPLIED' };
  const nextStatus: InboxStatus = request.status ?? (request.reply !== undefined ? 'IN_PROGRESS' : current.status);
  if (request.reply === undefined && nextStatus === current.status) return { ok: false, reason: 'NOTHING_TO_CHANGE' };
  return { ok: true, nextStatus, reply: request.reply ?? null };
}
