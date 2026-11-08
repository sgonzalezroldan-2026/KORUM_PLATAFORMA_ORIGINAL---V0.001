import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { cleanIdeaText } from '@/core/ideas/idea-rules';

/**
 * Reglas puras del soporte y del chat anónimo de las ideas (Sprint 3.9, QA-F06). Sin base de datos: lo que se puede escribir, adónde va cada
 * consulta y los topes que impiden que una cuenta llene la bandeja del centro o de KORUM.
 */

export const SUPPORT_SUBJECT_MIN = 5;
export const SUPPORT_SUBJECT_MAX = 120;
export const SUPPORT_MESSAGE_MIN = 20;
export const SUPPORT_MESSAGE_MAX = 2000;
export const CHAT_MESSAGE_MIN = 2;
export const CHAT_MESSAGE_MAX = 600;
/** Mensajes seguidos de la familia sin respuesta del centro: a partir de aquí espera. Evita un monólogo y una bandeja inundada. */
export const CHAT_UNANSWERED_MAX = 3;
/** Tope de mensajes de la familia en una misma idea durante toda su vida. */
export const CHAT_FAMILY_MESSAGES_MAX = 60;

export const SUPPORT_TOPICS = ['INITIATIVE', 'PAYMENT', 'ACCOUNT', 'RECTIFICATION', 'OTHER'] as const;
export type SupportTopicValue = (typeof SUPPORT_TOPICS)[number];
export type SupportTargetValue = 'ORGANIZATION' | 'SUPERADMIN';

/** Una consulta sobre una iniciativa o un evento la contesta el centro; pagos, cuenta, datos personales y sugerencias, KORUM. */
export function targetOfTopic(topic: SupportTopicValue): SupportTargetValue {
  return topic === 'INITIATIVE' ? 'ORGANIZATION' : 'SUPERADMIN';
}

/** Conserva los saltos de línea (un mensaje de soporte tiene párrafos), pero quita lo invisible, lo apilado y los saltos de más. */
export function cleanSupportText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(cleanIdeaText)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const supportTicketSchema = z.object({
  orgSlug: z.string().min(1).max(80),
  topic: z.enum(SUPPORT_TOPICS),
  subject: z.string().transform(cleanIdeaText).pipe(z.string().min(SUPPORT_SUBJECT_MIN).max(SUPPORT_SUBJECT_MAX)),
  message: z.string().transform(cleanSupportText).pipe(z.string().min(SUPPORT_MESSAGE_MIN).max(SUPPORT_MESSAGE_MAX))
});
export type SupportTicketInput = z.infer<typeof supportTicketSchema>;

export const chatMessageSchema = z.object({
  ideaId: z.number().int().positive().max(2_147_483_647),
  body: z.string().transform(cleanSupportText).pipe(z.string().min(CHAT_MESSAGE_MIN).max(CHAT_MESSAGE_MAX))
});

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** `TCK-7K3M9Q`: sin caracteres que se confunden al dictarlos (0/O, 1/I/L). El servidor lo genera siempre. */
export function generateTicketCode(random: (max: number) => number = (max) => randomInt(max)): string {
  return `TCK-${Array.from({ length: 6 }, () => CODE_ALPHABET.charAt(random(CODE_ALPHABET.length))).join('')}`;
}

export const isTicketCode = (value: string): boolean => /^TCK-[A-HJKMNP-Z2-9]{6}$/.test(value);

/** El chat sigue abierto mientras la idea vive: en revisión, en firmas o esperando la doble firma. Rechazada o convertida, solo se lee. */
const CHAT_OPEN_PHASES: readonly string[] = ['PHASE0_MOD', 'PUBLIC_VOTING', 'DOUBLE_CHECK'];
export const chatIsOpen = (phase: string): boolean => CHAT_OPEN_PHASES.includes(phase);

export type ChatBlock = 'CLOSED' | 'WAIT_FOR_CENTER' | 'LIMIT_REACHED';

/** ¿Puede la familia escribir ahora? `messages` va en orden: los últimos de la familia sin respuesta del centro frenan el siguiente. */
export function chatBlockReason(phase: string, messages: ReadonlyArray<{ senderRole: 'FAMILY' | 'ORGANIZATION' | 'SYSTEM' }>): ChatBlock | null {
  if (!chatIsOpen(phase)) return 'CLOSED';
  if (messages.filter((message) => message.senderRole === 'FAMILY').length >= CHAT_FAMILY_MESSAGES_MAX) return 'LIMIT_REACHED';
  let unanswered = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.senderRole;
    if (role === 'ORGANIZATION') break;
    if (role === 'FAMILY') unanswered += 1;
  }
  return unanswered >= CHAT_UNANSWERED_MAX ? 'WAIT_FOR_CENTER' : null;
}
