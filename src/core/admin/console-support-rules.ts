import { z } from 'zod';
import { cleanIdeaText } from '@/core/ideas/idea-rules';
import { safeDisplayText } from '@/core/security/safe-text';
import { cleanSupportText, isTicketCode, SUPPORT_MESSAGE_MAX, SUPPORT_MESSAGE_MIN, SUPPORT_SUBJECT_MAX, SUPPORT_SUBJECT_MIN } from '@/core/support/support-rules';
import { reviewNote } from './org-360-rules';

/**
 * Reglas puras de la bandeja de soporte de la consola y de otras acciones de gestión de la consola del Super-Admin (Sprint 5.3). Sin base de datos.
 * Contestar y cambiar el estado reutiliza `answerTicketSchema` y `planTicketAnswer` de la bandeja del centro: una sola respuesta por consulta y un estado
 * que solo avanza (`OPEN → IN_PROGRESS → RESOLVED`).
 */

/**
 * Direcciones y enlaces: un texto libre con el nombre de la plataforma no puede llevar ninguno (un cliente de correo convierte en enlace una dirección escrita, y sería
 * el camino más corto a un phishing: auditoría de seguridad del 5.3, I3). Se rechaza un esquema (`https:`, `//`), `www.`, un `@` y **cualquier** dominio (letras, un punto y letras: un cliente de correo convierte en enlace terminaciones nuevas como `.help` o `.ai`). Un texto como `importe.Total` también se rechaza: es preferible a dejar pasar un enlace.
 */
export const hasLinkOrAddress = (value: string): boolean => /(https?:|ftp:|\/\/|www\.|@)/i.test(value) || /\b[a-z0-9-]{2,}\.[a-z]{2,}\b/i.test(value);
const noLinks = (value: string) => !hasLinkOrAddress(value);

/** Email directo de KORUM a quienes firman por una entidad (prototipo `✉️ Enviar email directo al centro`): texto libre, sin enlaces, con tope por entidad y por persona. */
export const directEmailSchema = z
  .object({
    subject: z.string().transform(cleanIdeaText).pipe(z.string().min(SUPPORT_SUBJECT_MIN).max(SUPPORT_SUBJECT_MAX)).refine(noLinks, { message: 'LINKS' }),
    message: z.string().transform(cleanSupportText).pipe(z.string().min(SUPPORT_MESSAGE_MIN).max(SUPPORT_MESSAGE_MAX)).refine(noLinks, { message: 'LINKS' })
  })
  .strict();
export type DirectEmailInput = z.infer<typeof directEmailSchema>;

/** Cerrar la solicitud RGPD de rectificación que abrió una consulta (`Soporte TCK-…`), tras hacer el cambio comprobando la identidad. */
export const rectificationCloseSchema = z
  .object({
    ticketCode: z.string().refine(isTicketCode),
    outcome: z.enum(['COMPLETED', 'REJECTED']),
    notes: reviewNote.optional()
  })
  .strict();
export type RectificationCloseInput = z.infer<typeof rectificationCloseSchema>;

/** Corregir el nombre de la cuenta de quien pidió la rectificación (RGPD art. 16): el código de su consulta y el nombre correcto. El cambio de email no se hace desde aquí. */
export const rectifyNameSchema = z
  .object({
    ticketCode: z.string().refine(isTicketCode),
    name: z
      .string()
      .transform((value) => safeDisplayText(value, 121))
      .pipe(z.string().min(2).max(120))
  })
  .strict();
export type RectifyNameInput = z.infer<typeof rectifyNameSchema>;

/** Alertas que se cierran con una nota de quien las atiende (dinero que solo se arregla con Paycomet): sin ella no se cierran. */
export const NOTE_CLOSED_ALERT_TYPES = ['PAYOUT_BLOCKED', 'ACTIVITY_FUND_WINDOW'] as const;
export const isNoteClosedAlertType = (type: string): boolean => (NOTE_CLOSED_ALERT_TYPES as readonly string[]).includes(type);

export const resolveWithNoteSchema = z.object({ alertId: z.string().trim().min(1).max(40), note: reviewNote }).strict();

/** Un reparto de resultado desconocido: Paycomet confirma que se hizo (con el código de autorización del reparto) o que no se hizo. */
const authCode = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const splitResolutionSchema = z
  .object({
    kind: z.enum(['CAMPAIGN', 'FUND']),
    splitId: z.number().int().positive().max(2_147_483_647),
    splitAuthCode: authCode.nullable()
  })
  .strict();
export type SplitResolutionInput = z.infer<typeof splitResolutionSchema>;
