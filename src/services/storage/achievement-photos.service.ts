import { ImageMetadataError, stripImageMetadata } from '@/core/media/strip-image-metadata';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { queuePhotosBroadcastIfReady } from '@/services/notifications/supporter-broadcast';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, recordAudit, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { FileRejectedError, uploadFile } from './file-asset.service';
import type { StorageProvider } from './storage-provider';

/**
 * Fotos Antes / Después de un logro y mensaje de agradecimiento del centro (Sprint 3.6, QA-F09; Cumplimiento legal: fotos sin menores
 * identificables). Solo quienes firman en la entidad (`DIRECTOR`, `COSIGNER`), con la confirmación expresa de que **no aparecen menores
 * identificables** (queda en `AuditLog` con quién, cuándo y qué foto). La imagen se reescribe sin metadatos (EXIF con la ubicación del móvil, XMP,
 * comentarios) **antes** de ir al cubo público; el original no se guarda. Subir otra foto sustituye a la anterior, que se retira del cubo público.
 * Las familias las ven cuando la iniciativa está cerrada (liquidación hecha con doble firma, Sprint 4.4a).
 */

export type AchievementSlot = 'BEFORE' | 'AFTER';

export type AchievementPhotoRejection = 'CONFIRMATION_REQUIRED' | 'INITIATIVE_NOT_EDITABLE' | 'UNREADABLE_IMAGE';

export class AchievementPhotoRejectedError extends Error {
  readonly reason: AchievementPhotoRejection;

  constructor(reason: AchievementPhotoRejection) {
    super(`La foto no se puede publicar: ${reason}.`);
    this.name = 'AchievementPhotoRejectedError';
    this.reason = reason;
  }
}

const STAFF = ['DIRECTOR', 'COSIGNER'] as const;
/** Una iniciativa en preparación, vencida o reembolsada no tiene logro que enseñar. */
const PHOTO_STATUSES = ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED'] as const;
export const THANKS_MESSAGE_MAX = 400;
/** Las funciones serverless de Vercel admiten 4,5 MB de cuerpo: la foto se limita a 4 MB y el resto del formulario cabe en el margen. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export interface PublishPhotoInput {
  organizationId: string;
  initiativeId: number;
  slot: AchievementSlot;
  bytes: Uint8Array;
  declaredMimeType: string;
  fileName?: string;
  /** Casilla obligatoria del formulario: «En la foto no aparecen menores identificables». */
  noIdentifiableMinors: boolean;
}

async function loadEditableInitiative(db: KorumPrismaClient, actor: SessionActor, organizationId: string, initiativeId: number) {
  const initiative = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true, status: true, beforeFileId: true, afterFileId: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Initiative', resourceId: initiativeId, resourceLabel: 'Iniciativa', ownerOrganizationId: initiative?.organizationId ?? null });
  if (!initiative) throw new ResourceNotFoundError('Iniciativa');
  if (!(PHOTO_STATUSES as readonly string[]).includes(initiative.status)) throw new AchievementPhotoRejectedError('INITIATIVE_NOT_EDITABLE');
  return initiative;
}

/**
 * Quien firma por una entidad solo tiene aquí sus derechos con el segundo factor de **esta** sesión. La ruta ya lo comprueba; se repite en el servicio
 * para que una futura Server Action, que no pasa por ella, no pueda olvidarlo (defensa en profundidad).
 */
async function requireSecondFactor(db: KorumPrismaClient, actor: SessionActor, organizationId: string, action: string): Promise<void> {
  if (actor.kind === 'user' && actor.secondFactor === true) return;
  await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, targetType: 'Initiative', targetId: '-', metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: action } });
  throw new TenantAccessError('ROLE_NOT_ALLOWED');
}

export async function publishAchievementPhoto(db: KorumPrismaClient, storage: StorageProvider, actor: SessionActor, input: PublishPhotoInput) {
  if (input.noIdentifiableMinors !== true) throw new AchievementPhotoRejectedError('CONFIRMATION_REQUIRED');
  const target = { targetType: 'Initiative', action: 'achievement.photo' };
  await requireSecondFactor(db, actor, input.organizationId, target.action);
  await authorizeTenant(db, actor, input.organizationId, { roles: STAFF, ...target, allowSuperadmin: false });
  await loadEditableInitiative(db, actor, input.organizationId, input.initiativeId);

  let clean;
  try {
    clean = stripImageMetadata(input.bytes);
  } catch (error) {
    if (error instanceof ImageMetadataError) throw new AchievementPhotoRejectedError('UNREADABLE_IMAGE');
    throw error;
  }
  // `uploadFile` valida el tipo real, el tamaño y la extensión, y no admite nada que no sea imagen en este uso.
  const purpose = input.slot === 'BEFORE' ? 'INITIATIVE_BEFORE' : 'INITIATIVE_AFTER';
  const asset = await uploadFile(db, storage, {
    purpose,
    bytes: clean.bytes,
    declaredMimeType: input.declaredMimeType,
    fileName: input.fileName,
    organizationId: input.organizationId,
    uploadedById: actor.kind === 'user' ? actor.userId : null
  });

  // Todo en una transacción: la fila de la iniciativa queda bloqueada (dos subidas a la vez al mismo hueco se ponen en cola y la segunda ve la primera
  // como foto anterior, sin dejar ningún fichero público huérfano) y la auditoría con la confirmación de menores es obligatoria: sin ese rastro, la
  // foto no se publica.
  let previous: { bucket: string; objectKey: string } | null = null;
  try {
    previous = await inTransaction(db, async (tx) => {
      const current = await tx.initiative.update({ where: { id: input.initiativeId }, data: { updatedAt: new Date() }, select: { beforeFileId: true, afterFileId: true } });
      const previousId = input.slot === 'BEFORE' ? current.beforeFileId : current.afterFileId;
      await tx.initiative.update({ where: { id: input.initiativeId }, data: input.slot === 'BEFORE' ? { beforeFileId: asset.id } : { afterFileId: asset.id } });
      // Con la iniciativa ya cerrada y las dos fotos, «Mirad cómo ha quedado» a quienes donaron (una vez; Sprint 4.4a).
      await queuePhotosBroadcastIfReady(tx, input.initiativeId, new Date());
      await recordAudit(
        tx,
        actor,
        {
          action: 'achievement.photo_published',
          organizationId: input.organizationId,
          targetType: 'Initiative',
          targetId: String(input.initiativeId),
          // Nunca el contenido de los metadatos (podría llevar una ubicación): solo qué tipos de bloque se retiraron.
          metadata: { slot: input.slot, fileId: asset.id, noIdentifiableMinorsConfirmed: true, removedMetadata: clean.removed }
        },
        { required: true }
      );
      if (!previousId) return null;
      return tx.fileAsset.update({ where: { id: previousId }, data: { deletedAt: new Date() }, select: { bucket: true, objectKey: true } });
    });
  } catch (error) {
    await storage.remove(asset.bucket, asset.objectKey).catch(() => undefined);
    await db.fileAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } }).catch(() => undefined);
    throw error;
  }
  if (previous) await storage.remove(previous.bucket, previous.objectKey).catch(() => undefined);
  return { fileId: asset.id, removedMetadata: clean.removed };
}

/** Mensaje de agradecimiento del centro a las familias (`Initiative.thanksMessage`). Vacío lo quita. */
export async function saveThanksMessage(db: KorumPrismaClient, actor: SessionActor, input: { organizationId: string; initiativeId: number; message: string }) {
  await requireSecondFactor(db, actor, input.organizationId, 'achievement.thanks');
  await authorizeTenant(db, actor, input.organizationId, { roles: STAFF, action: 'achievement.thanks', targetType: 'Initiative', allowSuperadmin: false });
  await loadEditableInitiative(db, actor, input.organizationId, input.initiativeId);
  const message = input.message.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, THANKS_MESSAGE_MAX);
  await db.initiative.update({ where: { id: input.initiativeId }, data: { thanksMessage: message === '' ? null : message } });
  await recordAudit(db, actor, { action: 'achievement.thanks_saved', organizationId: input.organizationId, targetType: 'Initiative', targetId: String(input.initiativeId), metadata: { length: message.length } });
  return message;
}

export { FileRejectedError };
