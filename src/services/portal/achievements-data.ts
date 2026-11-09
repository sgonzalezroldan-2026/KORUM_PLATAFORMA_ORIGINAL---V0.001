import type { AchievementCardData } from '@/components/achievements/achievement-grid';
import { formatCents, type MoneyLocale } from '@/core/finance/money';
import { localizeRow } from '@/core/public/view-model';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { initiativePath } from '@/lib/seo/portal-routes';
import { getPrisma } from '@/lib/prisma';
import { listPublicAchievements } from '@/repositories/achievements.repository';
import { loadPortalOrganization } from './portal-data';

/** Dirección pública de una imagen de la entidad (ver `src/app/api/files/public/[id]/route.ts`). Nunca una URL firmada ni la clave del objeto. */
export const publicFileSrc = (fileId: string): string => `/api/files/public/${fileId}`;

/** Logotipo de un comercio, solo si sigue publicado: un fichero retirado o privado nunca se enlaza. */
export const publicLogoSrc = (file: { id: string; visibility: string; deletedAt: Date | null } | null): string | null =>
  file && file.visibility === 'PUBLIC' && file.deletedAt === null ? publicFileSrc(file.id) : null;

/**
 * Logros de la entidad listos para pintar (Sprint 3.6): iniciativas conseguidas o cerradas, con sus textos en el idioma de la página si la entidad
 * los tradujo, el total que sumó la comunidad y las fotos solo si son públicas. Sin personas, sin cursos y sin comparaciones.
 */
export async function loadAchievements(slug: string, locale: MoneyLocale): Promise<AchievementCardData[]> {
  const [organization, rows] = await Promise.all([loadPortalOrganization(slug), listPublicAchievements(getPrisma(), slug)]);
  return rows.map((row) => {
    const { row: localized, lang } = localizeRow(row, locale, organization.contentLocale);
    return {
      id: row.id,
      title: localized.title,
      description: localized.description,
      thanksMessage: row.thanksMessage,
      raised: formatCents(row.raisedCents, locale),
      beforeSrc: row.beforeFileId ? publicFileSrc(row.beforeFileId) : null,
      afterSrc: row.afterFileId ? publicFileSrc(row.afterFileId) : null,
      href: initiativePath(slug, row.id),
      url: absoluteUrl(locale, initiativePath(slug, row.id)),
      lang
    };
  });
}
