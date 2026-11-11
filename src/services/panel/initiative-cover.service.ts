import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from '@/repositories/ownership';
import { recordAudit, ResourceNotFoundError, type SessionActor } from '@/repositories/tenant-guard';
import { ImageResizeError, prepareWebImage } from '@/services/media/resize-image';
import { uploadFile } from '@/services/storage/file-asset.service';
import type { StorageProvider } from '@/services/storage/storage-provider';
import { requireSigner } from './kyb.service';

/**
 * Imagen representativa de una campaña (Sprint 4.4c, anclas `id="initiative-cover"` y `function handleInitiativeCoverUpload` del prototipo): la foto
 * que se ve en la ficha y en la tarjeta del portal y en la tarjeta de WhatsApp. Las dos personas firmantes, con el segundo factor y la auditoría en la
 * misma transacción que la cambia.
 *
 * - **Sin metadatos y más ligera:** se reduce a 1.600 px y se recodifica (`prepareWebImage`), así que no sale ni la ubicación del móvil ni un fichero de
 *   cuatro megas en una ficha que se abre en 4G. El original no se guarda.
 * - **Menores:** como la portada de la entidad y las fotos de logros, quien sube confirma que no aparecen menores reconocibles (queda en la auditoría).
 * - **Cuándo:** una campaña en preparación, recaudando, conseguida o cerrada. Una cancelada, vencida o reembolsada ya no se enseña.
 * - Cambiar la imagen actualiza `updatedAt` de la campaña: la tarjeta de WhatsApp se versiona con él y los enlaces ya compartidos muestran la nueva.
 */

export type InitiativeCoverRejection = 'UNREADABLE_IMAGE' | 'MINORS_NOT_CONFIRMED' | 'CONFLICT' | 'NOT_EDITABLE';

export class InitiativeCoverError extends Error {
  readonly reason: InitiativeCoverRejection;

  constructor(reason: InitiativeCoverRejection) {
    super(`Imagen de la campaña rechazada: ${reason}.`);
    this.name = 'InitiativeCoverError';
    this.reason = reason;
  }
}

const COVER_STATUSES = ['BUDGETING', 'FUNDRAISING', 'GOAL_REACHED', 'CLOSED'] as const;

/** `requireEditable = false` (quitar): la imagen se puede retirar en cualquier estado de la campaña; una familia puede pedirlo también cuando ya está cancelada o devuelta. */
async function loadCoverTarget(db: KorumPrismaClient, actor: SessionActor, organizationId: string, initiativeId: number, requireEditable = true) {
  const initiative = await db.initiative.findUnique({ where: { id: initiativeId }, select: { organizationId: true, status: true, coverFileId: true } });
  await requireOwnedResource(db, actor, { organizationId, resourceType: 'Initiative', resourceId: initiativeId, resourceLabel: 'Iniciativa', ownerOrganizationId: initiative?.organizationId ?? null });
  if (!initiative) throw new ResourceNotFoundError('Iniciativa');
  if (requireEditable && !(COVER_STATUSES as readonly string[]).includes(initiative.status)) throw new InitiativeCoverError('NOT_EDITABLE');
  return initiative;
}

export interface PublishInitiativeCoverInput {
  organizationId: string;
  initiativeId: number;
  bytes: Uint8Array;
  declaredMimeType: string;
  fileName: string;
  /** Casilla obligatoria del formulario: «En la imagen no aparecen menores identificables». */
  noMinorsConfirmed: boolean;
}

export async function publishInitiativeCover(db: KorumPrismaClient, storage: StorageProvider, actor: SessionActor, input: PublishInitiativeCoverInput): Promise<{ fileId: string }> {
  const signer = await requireSigner(db, actor, input.organizationId, 'initiative.cover_upload');
  if (input.noMinorsConfirmed !== true) throw new InitiativeCoverError('MINORS_NOT_CONFIRMED');
  await loadCoverTarget(db, actor, input.organizationId, input.initiativeId);

  let clean;
  try {
    clean = await prepareWebImage(input.bytes);
  } catch (error) {
    if (error instanceof ImageResizeError) throw new InitiativeCoverError('UNREADABLE_IMAGE');
    throw error;
  }
  const asset = await uploadFile(db, storage, {
    purpose: 'INITIATIVE_COVER',
    bytes: clean.bytes,
    declaredMimeType: input.declaredMimeType,
    fileName: input.fileName,
    organizationId: input.organizationId,
    uploadedById: signer.userId
  });

  let previous: { bucket: string; objectKey: string } | null = null;
  try {
    previous = await inTransaction(db, async (tx) => {
      // Se bloquea la fila: dos subidas a la vez se ponen en cola y la segunda ve la primera como imagen anterior (sin ningún fichero público huérfano).
      const current = await tx.initiative.update({ where: { id: input.initiativeId }, data: { updatedAt: new Date() }, select: { coverFileId: true, status: true, organizationId: true } });
      if (current.organizationId !== input.organizationId || !(COVER_STATUSES as readonly string[]).includes(current.status)) throw new InitiativeCoverError('NOT_EDITABLE');
      await tx.initiative.update({ where: { id: input.initiativeId }, data: { coverFileId: asset.id } });
      await recordAudit(
        tx,
        signer,
        {
          action: 'initiative.cover_published',
          organizationId: input.organizationId,
          targetType: 'Initiative',
          targetId: String(input.initiativeId),
          // Nunca el contenido de los metadatos (podría llevar una ubicación): solo qué tipos de bloque llevaba el original.
          metadata: { fileId: asset.id, noMinorsConfirmed: true, removedMetadata: clean.removed, width: clean.width, height: clean.height }
        },
        { required: true }
      );
      if (!current.coverFileId) return null;
      return tx.fileAsset.update({ where: { id: current.coverFileId }, data: { deletedAt: new Date() }, select: { bucket: true, objectKey: true } });
    });
  } catch (error) {
    await storage.remove(asset.bucket, asset.objectKey).catch(() => undefined);
    await db.fileAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } }).catch(() => undefined);
    throw error;
  }
  if (previous) await storage.remove(previous.bucket, previous.objectKey).catch(() => undefined);
  return { fileId: asset.id };
}

/** Quita la imagen de la campaña (vuelve el degradado de la tarjeta) y la retira del almacén. Devuelve `false` si no había ninguna. */
export async function removeInitiativeCover(db: KorumPrismaClient, storage: StorageProvider, actor: SessionActor, organizationId: string, initiativeId: number): Promise<boolean> {
  const signer = await requireSigner(db, actor, organizationId, 'initiative.cover_remove');
  await loadCoverTarget(db, actor, organizationId, initiativeId, false);
  const previous = await inTransaction(db, async (tx) => {
    const current = await tx.initiative.update({ where: { id: initiativeId }, data: { updatedAt: new Date() }, select: { coverFileId: true } });
    if (!current.coverFileId) return null;
    await tx.initiative.update({ where: { id: initiativeId }, data: { coverFileId: null } });
    await recordAudit(tx, signer, { action: 'initiative.cover_removed', organizationId, targetType: 'Initiative', targetId: String(initiativeId), metadata: { fileId: current.coverFileId } }, { required: true });
    return tx.fileAsset.update({ where: { id: current.coverFileId }, data: { deletedAt: new Date() }, select: { bucket: true, objectKey: true } });
  });
  if (!previous) return false;
  await storage.remove(previous.bucket, previous.objectKey).catch(() => undefined);
  return true;
}
