import { randomInt } from 'node:crypto';
import { z } from 'zod';

/**
 * Reglas puras del buzón de ideas (Sprint 3.6, QA-F09). El alias de una idea es siempre `#FAM-NNNN`, generado aquí: nunca texto libre de la
 * familia («Mamá de Lucas 3ºB»), porque sobrevive a la supresión de la cuenta (heredado del Sprint 2.5).
 */

export const IDEA_TITLE_MAX = 90;
export const IDEA_DESCRIPTION_MAX = 600;
export const IDEA_TITLE_MIN = 8;
export const IDEA_DESCRIPTION_MIN = 20;
/** Una persona no puede inundar el buzón: ideas propuestas al día en una misma entidad, y a la vez pendientes de revisión o de firmas. */
export const IDEAS_PER_PERSON_PER_DAY = 3;
export const IDEAS_OPEN_PER_PERSON = 5;

const ALIAS_PATTERN = /^#FAM-\d{4}$/;
const ALIAS_IN_TEXT = /#FAM-\d{4}/;

/** `#FAM-4821`: cuatro cifras al azar con el generador criptográfico (no se pueden adivinar a partir de las anteriores). */
export function generateIdeaAlias(random: (max: number) => number = (max) => randomInt(max)): string {
  return `#FAM-${String(1000 + random(9000))}`;
}

export const isIdeaAlias = (value: string): boolean => ALIAS_PATTERN.test(value);

/** El código que se enseña (`#FAM-4821`), también para alias antiguos con prefijo («Código #FAM-4821»); sin patrón reconocible, nada del texto. */
export function displayIdeaAlias(stored: string): string {
  return ALIAS_IN_TEXT.exec(stored)?.[0] ?? '#FAM-0000';
}

/** Caracteres de control y de formato (invisibles, de dirección de texto) fuera: no hay texto oculto ni títulos que se lean al revés. */
const INVISIBLE = /[\p{Cc}\p{Cf}ᅟᅠㅤﾠ︀-️]/gu;
/** Marcas combinantes en cadena («zalgo»): más de dos seguidas no se escriben en ningún idioma. */
const STACKED_MARKS = /\p{M}{3,}/gu;

export function cleanIdeaText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(INVISIBLE, ' ')
    .replace(STACKED_MARKS, (run) => run.slice(0, 2))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

export const proposeIdeaSchema = z.object({
  orgSlug: z.string().min(1).max(80),
  title: z.string().transform(cleanIdeaText).pipe(z.string().min(IDEA_TITLE_MIN).max(IDEA_TITLE_MAX)),
  category: z.string().transform(cleanIdeaText).pipe(z.string().min(1).max(80)),
  description: z.string().transform(cleanIdeaText).pipe(z.string().min(IDEA_DESCRIPTION_MIN).max(IDEA_DESCRIPTION_MAX))
});
export type ProposeIdeaInput = z.infer<typeof proposeIdeaSchema>;

export interface IdeaProgress {
  /** 0–100 de las firmas verificadas sobre el mínimo de la entidad. */
  percent: number;
  quorumReached: boolean;
  daysRemaining: number;
}

const DAY_MS = 86_400_000;

/**
 * El quórum cuenta solo las firmas verificadas (`verifiedVotes`): las sospechosas se registran, pero no suman (skill de antifraude §2). Los días
 * restantes se redondean hacia arriba: una idea que caduca esta noche aún tiene «1 día».
 */
export function ideaProgress(idea: { verifiedVotes: number; expiresAt: Date }, minVotes: number, now: Date): IdeaProgress {
  const needed = Math.max(1, minVotes);
  return {
    percent: Math.min(100, Math.floor((Math.max(0, idea.verifiedVotes) / needed) * 100)),
    quorumReached: idea.verifiedVotes >= needed,
    daysRemaining: Math.max(0, Math.ceil((idea.expiresAt.getTime() - now.getTime()) / DAY_MS))
  };
}

/** Qué ofrece la tarjeta de una idea según su fase y si la persona ya firmó. */
export type IdeaAction = 'SIGN' | 'SIGNED' | 'CLOSED';

export function ideaAction(phase: string, signed: boolean, expiresAt: Date, now: Date): IdeaAction {
  if (phase !== 'PUBLIC_VOTING' || expiresAt.getTime() <= now.getTime()) return signed ? 'SIGNED' : 'CLOSED';
  return signed ? 'SIGNED' : 'SIGN';
}

/** Categorías que admite una idea: las de la entidad menos la de taquilla y rifas (que no es una mejora). */
export function ideaCategories(categories: readonly { name: string; icon: string }[]): { name: string; icon: string }[] {
  return categories.filter((category) => category.name !== 'Taquilla y Rifas');
}
