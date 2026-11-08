import { z } from 'zod';
import { cleanSupportText } from '@/core/support/support-rules';
import { cleanIdeaText, IDEA_DESCRIPTION_MAX, IDEA_DESCRIPTION_MIN, IDEA_TITLE_MAX, IDEA_TITLE_MIN } from './idea-rules';

/**
 * Reglas puras de la moderación de ideas (Sprint 4.2a), sin base de datos: lo que la entidad puede escribir al aprobar o desestimar y qué
 * motivos de firma son sospechosos. Las usan el servicio, la vista y las pruebas.
 */

export const REJECTION_REASON_MIN = 10;
const ideaId = z.number().int().positive().max(2_147_483_647);

export const approveIdeaSchema = z.object({
  ideaId,
  title: z.string().transform(cleanIdeaText).pipe(z.string().min(IDEA_TITLE_MIN).max(IDEA_TITLE_MAX)),
  category: z.string().transform(cleanIdeaText).pipe(z.string().min(1).max(80)),
  description: z.string().transform(cleanIdeaText).pipe(z.string().min(IDEA_DESCRIPTION_MIN).max(IDEA_DESCRIPTION_MAX))
});
export const rejectIdeaSchema = z.object({ ideaId, reason: z.string().transform(cleanSupportText).pipe(z.string().min(REJECTION_REASON_MIN).max(600)) });
export const revalidateSignatureSchema = z.object({ ideaId, signatureId: z.number().int().positive().max(2_147_483_647) });

/** Motivos de una firma sospechosa. Una firma `VERIFIED` con uno de estos motivos es una que la entidad revalidó a mano. */
export const SUSPICIOUS_REASONS: readonly string[] = ['ideas.audit.ipBurst', 'ideas.audit.tooManyAccounts'];
