import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeTenant, type SessionActor } from './tenant-guard';

/**
 * Logros conseguidos de una entidad (Entorno 1, Sprint 3.6): iniciativas `GOAL_REACHED` y `CLOSED` con su agradecimiento y, si la entidad las ha
 * subido, las fotos Antes / Después. Solo campos públicos; una foto solo cuenta si su fichero es público y no está borrado.
 */

const PUBLIC_FILE = { select: { id: true, visibility: true, deletedAt: true } } as const;

/** Tope de logros en pantalla (los más recientes primero). */
export const PUBLIC_ACHIEVEMENTS_LIMIT = 48;

export async function listPublicAchievements(db: KorumPrismaClient, slug: string) {
  const rows = await db.initiative.findMany({
    where: { status: { in: ['GOAL_REACHED', 'CLOSED'] }, organization: { slug, archivedAt: null } },
    select: {
      id: true,
      title: true,
      description: true,
      thanksMessage: true,
      raisedCents: true,
      format: true,
      closesAt: true,
      updatedAt: true,
      translationsJson: true,
      beforeFile: PUBLIC_FILE,
      afterFile: PUBLIC_FILE
    },
    orderBy: [{ closesAt: 'desc' }, { id: 'desc' }],
    take: PUBLIC_ACHIEVEMENTS_LIMIT
  });
  const publicId = (file: { id: string; visibility: string; deletedAt: Date | null } | null) => (file && file.visibility === 'PUBLIC' && file.deletedAt === null ? file.id : null);
  return rows.map(({ beforeFile, afterFile, ...row }) => ({ ...row, beforeFileId: publicId(beforeFile), afterFileId: publicId(afterFile) }));
}

/** Un fichero público de imagen, para servirlo por la ruta de desarrollo (`/api/files/public/[id]`). Nada más sale de aquí. */
export async function getPublicImageFile(db: KorumPrismaClient, fileId: string) {
  return db.fileAsset.findFirst({
    where: { id: fileId, visibility: 'PUBLIC', deletedAt: null, purpose: { in: ['INITIATIVE_BEFORE', 'INITIATIVE_AFTER', 'INITIATIVE_COVER', 'ORG_LOGO', 'ORG_BANNER', 'SPONSOR_LOGO'] } },
    select: { id: true, bucket: true, objectKey: true, mimeType: true, sha256: true }
  });
}

/**
 * Iniciativas de la entidad que ya pueden tener su logro (o lo van a tener), para que quien firma suba las fotos Antes / Después y escriba el
 * agradecimiento. Solo `DIRECTOR` y `COSIGNER` de esa entidad; la vista no lleva importes internos ni datos de personas.
 */
export async function listAchievementWorkbench(db: KorumPrismaClient, actor: SessionActor, organizationId: string) {
  await authorizeTenant(db, actor, organizationId, { roles: ['DIRECTOR', 'COSIGNER'], action: 'achievement.list', targetType: 'Initiative' });
  const rows = await db.initiative.findMany({
    where: { organizationId, status: { in: ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED'] } },
    select: { id: true, title: true, status: true, thanksMessage: true, beforeFileId: true, afterFileId: true },
    orderBy: [{ status: 'desc' }, { id: 'desc' }]
  });
  return rows;
}
