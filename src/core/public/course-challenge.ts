import { z } from 'zod';
import { OFFICIAL_CULTURAL_GROUPS, OFFICIAL_SCHOOL_13_COURSES, OFFICIAL_SPORTS_CLUB_GROUPS, type ParticipationGroupCluster } from '@/types/korum.types';

/**
 * Reto por curso, equipo o grupo, **solo en positivo** (Regla 03 §6): se muestra cada grupo que ya suma familias y cuánto le falta para el
 * reto; nunca quién no ha aportado, ni un ranking, ni importes por grupo. El orden es siempre el de la plantilla de la entidad (el orden
 * natural de los cursos), jamás por número de familias: ordenar de menos a más o de más a menos sería una clasificación.
 */

export interface CourseProgressRow {
  groupName: string;
  familiesCount: number;
}

export interface CourseChallengeLine {
  groupName: string;
  /** Identificador estable para el parámetro `?grupo=` de los enlaces compartidos. */
  slug: string;
  familiesCount: number;
  target: number;
  reached: boolean;
  /** Familias que faltan para el reto (0 si ya lo ha logrado). */
  missing: number;
  /** De 0 a 100, entero; solo 100 si lo ha logrado. */
  pct: number;
}

const clusterSchema = z.array(z.object({ group: z.string(), items: z.array(z.string()) }));

/** Plantilla oficial del vertical, la misma que carga el alta de la entidad. */
export function defaultGroupTemplate(vertical: string): ParticipationGroupCluster[] {
  if (vertical === 'SPORTS_CLUB') return OFFICIAL_SPORTS_CLUB_GROUPS;
  if (vertical === 'CULTURAL') return OFFICIAL_CULTURAL_GROUPS;
  return OFFICIAL_SCHOOL_13_COURSES;
}

/** Grupos de la entidad con sus bloques (Infantil, Primaria, ESO, Comunidad…): los suyos si los personalizó (y son válidos) o la plantilla. */
export function orderedGroupClusters(vertical: string, participationGroupsJson: unknown): ParticipationGroupCluster[] {
  const parsed = clusterSchema.safeParse(participationGroupsJson);
  const clusters = parsed.success && parsed.data.some((cluster) => cluster.items.length > 0) ? parsed.data : defaultGroupTemplate(vertical);
  return clusters.filter((cluster) => cluster.items.length > 0);
}

/** Nombres de los grupos en el orden de la entidad: los suyos si los personalizó (y son válidos) o los de la plantilla de su vertical. */
export function orderedGroupNames(vertical: string, participationGroupsJson: unknown): string[] {
  return orderedGroupClusters(vertical, participationGroupsJson).flatMap((cluster) => cluster.items);
}

/**
 * Identificador de un grupo para la URL: minúsculas, sin acentos ni signos y sin la palabra suelta «de»
 * (`3º de Primaria` → `3-primaria`, `Sénior / Primer Equipo` → `senior-primer-equipo`).
 */
export function groupSlug(groupName: string): string {
  return groupName
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^|-)de(?=-|$)/g, '$1')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
}

/** El grupo cuyo identificador coincide con `slug` (`?grupo=`), o `null`: el texto de la URL nunca se dibuja, solo se compara. */
export function findGroupBySlug(rows: readonly CourseProgressRow[], slug: string | null | undefined): CourseProgressRow | null {
  if (!slug) return null;
  return rows.find((row) => groupSlug(row.groupName) === slug) ?? null;
}

export function buildCourseChallenge(rows: readonly CourseProgressRow[], target: number, order: readonly string[]): CourseChallengeLine[] {
  const safeTarget = Number.isSafeInteger(target) && target > 0 ? target : 1;
  const position = new Map(order.map((name, index) => [name, index] as const));
  return rows
    .filter((row) => row.familiesCount > 0)
    .map((row) => {
      const reached = row.familiesCount >= safeTarget;
      return {
        groupName: row.groupName,
        slug: groupSlug(row.groupName),
        familiesCount: row.familiesCount,
        target: safeTarget,
        reached,
        missing: reached ? 0 : safeTarget - row.familiesCount,
        pct: reached ? 100 : Math.min(99, Math.floor((row.familiesCount * 100) / safeTarget))
      };
    })
    .sort((a, b) => {
      const indexA = position.get(a.groupName) ?? Number.MAX_SAFE_INTEGER;
      const indexB = position.get(b.groupName) ?? Number.MAX_SAFE_INTEGER;
      return indexA !== indexB ? indexA - indexB : a.groupName.localeCompare(b.groupName, 'es');
    });
}
