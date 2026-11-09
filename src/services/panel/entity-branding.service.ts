import { z } from 'zod';
import { accentById, ENTITY_ACCENT_IDS } from '@/core/brand/entity-palette';
import { ImageMetadataError, stripImageMetadata } from '@/core/media/strip-image-metadata';
import { inTransaction } from '@/lib/db';
import { reserveAttempt } from '@/lib/rate-limit';
import { ENTITY_IMAGE_UPLOAD_RULE } from '@/lib/rate-limit-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { recordAudit, type SessionActor } from '@/repositories/tenant-guard';
import { uploadFile } from '@/services/storage/file-asset.service';
import { FILE_RULES } from '@/services/storage/file-rules';
import type { StorageProvider } from '@/services/storage/storage-provider';
import { requireSigner } from './kyb.service';

/**
 * Identidad visual de la entidad (Sprint 4.2e, anclas `handleSchoolLogoUpload`, `handleSchoolBannerUpload`, `applySchoolTheme` y «Sin logo» del
 * prototipo): logotipo, portada y color de acento, que se ven en la cabecera del portal y en la tarjeta para WhatsApp. Las dos personas firmantes
 * (decisión del promotor del 2026-11-09), con el segundo factor y la auditoría en la misma transacción que lo cambia.
 *
 * - **Color:** solo de la paleta cerrada (`ENTITY_ACCENTS`), que mantiene el contraste del portal.
 * - **Imágenes:** se reescriben sin metadatos (una foto de móvil lleva la ubicación) y quedan públicas (`ORG_LOGO`, `ORG_BANNER`). La anterior se
 *   retira del almacén al publicar la nueva; quitarla deja el escudo con las iniciales (logotipo) o el fondo azul marino (portada).
 */

export type EntityImageKind = 'logo' | 'banner';
const PURPOSE = { logo: 'ORG_LOGO', banner: 'ORG_BANNER' } as const;
const COLUMN = { logo: 'logoFileId', banner: 'bannerFileId' } as const;

export const ENTITY_IMAGE_MAX_BYTES: Record<EntityImageKind, number> = {
  logo: FILE_RULES.ORG_LOGO.maxBytes,
  banner: FILE_RULES.ORG_BANNER.maxBytes
};

export class EntityBrandingError extends Error {
  constructor(readonly reason: 'INVALID' | 'UNREADABLE_IMAGE' | 'CONFLICT' | 'RATE_LIMITED' | 'MINORS_NOT_CONFIRMED') {
    super(`Identidad visual rechazada: ${reason}.`);
    this.name = 'EntityBrandingError';
  }
}

const accentSchema = z.object({ accent: z.enum(ENTITY_ACCENT_IDS) }).strict();

export async function saveEntityAccent(db: KorumPrismaClient, actor: SessionActor, organizationId: string, raw: unknown): Promise<string> {
  const signer = await requireSigner(db, actor, organizationId, 'organization.branding_update');
  const parsed = accentSchema.safeParse(raw);
  const accent = parsed.success ? accentById(parsed.data.accent) : null;
  if (!accent) throw new EntityBrandingError('INVALID');
  return inTransaction(db, async (tx) => {
    const before = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { brandPrimary: true }
    });
    await tx.organization.update({
      where: { id: organizationId },
      data: { brandPrimary: accent.hex }
    });
    await recordAudit(
      tx,
      signer,
      {
        action: 'organization.branding_updated',
        organizationId,
        targetType: 'Organization',
        targetId: organizationId,
        metadata: { before: before.brandPrimary, after: accent.hex }
      },
      { required: true }
    );
    return accent.hex;
  });
}

export interface PublishEntityImageInput {
  organizationId: string;
  kind: EntityImageKind;
  bytes: Uint8Array;
  declaredMimeType: string;
  fileName: string;
  /** Portada: quien sube confirma que no aparecen menores reconocibles (como las fotos de logros del 3.6). Queda en la auditoría. */
  noMinorsConfirmed?: boolean;
}

/**
 * Antes de leer el cuerpo de la subida: cargo en la entidad con segundo factor y tope de subidas por entidad (auditoría del 4.2e, M5). La ruta lo llama
 * sin haber leído nada.
 */
export async function authorizeEntityImageUpload(db: KorumPrismaClient, actor: SessionActor, organizationId: string, now: Date = new Date()): Promise<void> {
  await requireSigner(db, actor, organizationId, 'organization.image_upload');
  if (!(await reserveAttempt(db, `${ENTITY_IMAGE_UPLOAD_RULE.prefix}${organizationId}`, ENTITY_IMAGE_UPLOAD_RULE, now))) throw new EntityBrandingError('RATE_LIMITED');
}

export async function publishEntityImage(db: KorumPrismaClient, storage: StorageProvider, actor: SessionActor, input: PublishEntityImageInput): Promise<{ fileId: string }> {
  const signer = await requireSigner(db, actor, input.organizationId, 'organization.image_upload');
  // La portada es una foto pública y grande: sin la confirmación de que no salen menores reconocibles no se publica (auditoría del 4.2e, I7).
  if (input.kind === 'banner' && input.noMinorsConfirmed !== true) throw new EntityBrandingError('MINORS_NOT_CONFIRMED');
  let clean;
  try {
    clean = stripImageMetadata(input.bytes);
  } catch (error) {
    if (error instanceof ImageMetadataError) throw new EntityBrandingError('UNREADABLE_IMAGE');
    throw error;
  }
  const asset = await uploadFile(db, storage, {
    purpose: PURPOSE[input.kind],
    bytes: clean.bytes,
    declaredMimeType: input.declaredMimeType,
    fileName: input.fileName,
    organizationId: input.organizationId,
    uploadedById: signer.userId
  });
  const column = COLUMN[input.kind];

  let previous: { bucket: string; objectKey: string } | null = null;
  try {
    previous = await inTransaction(db, async (tx) => {
      const current = await tx.organization.findUniqueOrThrow({
        where: { id: input.organizationId },
        select: { logoFileId: true, bannerFileId: true }
      });
      const currentId = current[column];
      // Solo si nadie la ha cambiado entretanto: dos subidas a la vez no dejan un fichero público sin dueño (la segunda falla y retira el suyo).
      const { count } = await tx.organization.updateMany({
        where: { id: input.organizationId, [column]: currentId },
        data: { [column]: asset.id }
      });
      if (count !== 1) throw new EntityBrandingError('CONFLICT');
      await recordAudit(
        tx,
        signer,
        {
          action: 'organization.image_published',
          organizationId: input.organizationId,
          targetType: 'Organization',
          targetId: input.organizationId,
          metadata: {
            kind: input.kind,
            fileId: asset.id,
            removedMetadata: clean.removed,
            ...(input.kind === 'banner' ? { noMinorsConfirmed: true } : {})
          }
        },
        { required: true }
      );
      if (!currentId) return null;
      return tx.fileAsset.update({
        where: { id: currentId },
        data: { deletedAt: new Date() },
        select: { bucket: true, objectKey: true }
      });
    });
  } catch (error) {
    await storage.remove(asset.bucket, asset.objectKey).catch(() => undefined);
    await db.fileAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } }).catch(() => undefined);
    throw error;
  }
  if (previous) await storage.remove(previous.bucket, previous.objectKey).catch(() => undefined);
  return { fileId: asset.id };
}

/** «Sin logo» / «Sin portada»: se retira la imagen del portal y del almacén. Devuelve `false` si no había ninguna. */
export async function removeEntityImage(db: KorumPrismaClient, storage: StorageProvider, actor: SessionActor, organizationId: string, kind: EntityImageKind): Promise<boolean> {
  const signer = await requireSigner(db, actor, organizationId, 'organization.image_remove');
  const column = COLUMN[kind];
  const previous = await inTransaction(db, async (tx) => {
    await tx.organization.updateMany({
      where: { id: organizationId },
      data: { updatedAt: new Date() }
    });
    const current = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { logoFileId: true, bannerFileId: true }
    });
    const currentId = current[column];
    if (!currentId) return null;
    await tx.organization.update({
      where: { id: organizationId },
      data: { [column]: null }
    });
    await recordAudit(
      tx,
      signer,
      {
        action: 'organization.image_removed',
        organizationId,
        targetType: 'Organization',
        targetId: organizationId,
        metadata: { kind, fileId: currentId }
      },
      { required: true }
    );
    return tx.fileAsset.update({
      where: { id: currentId },
      data: { deletedAt: new Date() },
      select: { bucket: true, objectKey: true }
    });
  });
  if (!previous) return false;
  await storage.remove(previous.bucket, previous.objectKey).catch(() => undefined);
  return true;
}
