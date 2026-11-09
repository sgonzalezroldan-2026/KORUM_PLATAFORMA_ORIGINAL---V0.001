import { z } from 'zod';
import { LINK_LIKE } from '@/core/onboarding/registration-rules';
import { groupSlug } from '@/core/public/course-challenge';
import type { ParticipationGroupCluster } from '@/types/korum.types';

/**
 * Grupos de participación de la entidad (Sprint 4.2e, heredado del 3.2): la plantilla que el alta copia del vertical (13 cursos, categorías del club o
 * grupos culturales), editable por bloques. Son los nombres del desplegable del checkout, del reto por curso y del `?grupo=` de los enlaces.
 *
 * - **Sin enlaces ni emails:** los nombres salen en el portal, en las tarjetas de WhatsApp y en los emails.
 * - **Sin dos grupos con el mismo identificador** (`groupSlug`): «3º de Primaria» y «3º Primaria» serían el mismo `?grupo=3-primaria`, y el enlace
 *   compartido de un curso llevaría al otro. Tampoco un nombre sin letras ni cifras (su identificador quedaría vacío).
 * - **Renombrar no borra el progreso:** `InitiativeCourseProgress` lo guarda por nombre; un grupo renombrado empieza su cuenta y el antiguo, si ya
 *   sumaba familias, se sigue viendo al final del reto de esa campaña.
 */

export const GROUP_LIMITS = {
  blocks: 8,
  itemsPerBlock: 20,
  items: 60,
  blockName: 60,
  itemName: 40
} as const;

const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !LINK_LIKE.test(value));

export const participationGroupsSchema = z
  .object({
    blocks: z
      .array(
        z
          .object({
            group: plainText(GROUP_LIMITS.blockName),
            items: z.array(plainText(GROUP_LIMITS.itemName)).min(1).max(GROUP_LIMITS.itemsPerBlock)
          })
          .strict()
      )
      .min(1)
      .max(GROUP_LIMITS.blocks)
  })
  .strict();

export type GroupIssue = { code: 'DUPLICATE'; names: [string, string] } | { code: 'EMPTY_SLUG'; name: string } | { code: 'TOO_MANY'; total: number };

/** Lo que el esquema no puede ver: identificadores repetidos o vacíos y el total de grupos. */
export function groupIssues(blocks: readonly ParticipationGroupCluster[]): GroupIssue[] {
  const issues: GroupIssue[] = [];
  const seen = new Map<string, string>();
  let total = 0;
  for (const block of blocks) {
    for (const name of block.items) {
      total += 1;
      const slug = groupSlug(name);
      if (slug === '') {
        issues.push({ code: 'EMPTY_SLUG', name });
        continue;
      }
      const previous = seen.get(slug);
      if (previous !== undefined) issues.push({ code: 'DUPLICATE', names: [previous, name] });
      else seen.set(slug, name);
    }
  }
  if (total > GROUP_LIMITS.items) issues.push({ code: 'TOO_MANY', total });
  return issues;
}

/** Bloques limpios para guardar en `participationGroupsJson` (sin espacios de más). */
export function toStoredGroups(blocks: readonly ParticipationGroupCluster[]): ParticipationGroupCluster[] {
  return blocks.map((block) => ({
    group: block.group.trim(),
    items: block.items.map((item) => item.trim())
  }));
}
