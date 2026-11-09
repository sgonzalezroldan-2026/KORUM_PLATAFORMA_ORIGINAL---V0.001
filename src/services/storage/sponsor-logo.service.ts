import { ImageMetadataError, stripImageMetadata } from '@/core/media/strip-image-metadata';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { inTransaction } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { requireOwnedResource } from '@/repositories/ownership';
import { authorizeTenant, recordAudit, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { uploadFile } from './file-asset.service';
import type { StorageProvider } from './storage-provider';

/**
 * Logotipo de un comercio amigo (heredado del Sprint 3.5, punto 7). El comercio no tiene cuenta: lo envía al centro (por email, como en el prototipo)
 * y quien firma por la entidad lo sube desde la bandeja de aprobaciones. Se reescribe sin metadatos (una foto de móvil puede llevar la ubicación),
 * queda público (`SPONSOR_LOGO`) y se ve en la tarjeta del directorio y en el cartel del escaparate. Mismas garantías que las fotos de logros:
 * segundo factor, cargo en esta entidad, comercio de esta entidad y auditoría obligatoria en la misma transacción que lo publica.
 */

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export type SponsorLogoRejection = 'SPONSOR_NOT_ACTIVE' | 'UNREADABLE_IMAGE';

export class SponsorLogoRejectedError extends Error {
  readonly reason: SponsorLogoRejection;

  constructor(reason: SponsorLogoRejection) {
    super(`No se puede publicar el logotipo: ${reason}.`);
    this.name = 'SponsorLogoRejectedError';
    this.reason = reason;
  }
}

export interface PublishSponsorLogoInput {
  organizationId: string;
  sponsorId: number;
  bytes: Uint8Array;
  declaredMimeType: string;
  fileName: string;
}

const ACTION = 'sponsor.logo';

export async function publishSponsorLogo(db: KorumPrismaClient, storage: StorageProvider, actor: SessionActor, input: PublishSponsorLogoInput): Promise<{ fileId: string }> {
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId: input.organizationId, targetType: 'Sponsor', targetId: String(input.sponsorId), metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: ACTION } });
    throw new TenantAccessError(actor.kind === 'user' ? 'ROLE_NOT_ALLOWED' : 'ANONYMOUS');
  }
  await authorizeTenant(db, actor, input.organizationId, { roles: SIGNER_ROLES, action: ACTION, targetType: 'Sponsor', targetId: input.sponsorId, allowSuperadmin: false });
  const owner = await db.sponsor.findUnique({ where: { id: input.sponsorId }, select: { organizationId: true, status: true, paidAt: true } });
  await requireOwnedResource(db, actor, { organizationId: input.organizationId, resourceType: 'Sponsor', resourceId: input.sponsorId, resourceLabel: 'Comercio', ownerOrganizationId: owner?.organizationId ?? null });
  // Solo de un comercio cobrado y vigente o por revisar: subir el logo de uno devuelto lo publicaría sin motivo.
  if (!owner?.paidAt || (owner.status !== 'PENDING' && owner.status !== 'APPROVED')) throw new SponsorLogoRejectedError('SPONSOR_NOT_ACTIVE');

  let clean;
  try {
    clean = stripImageMetadata(input.bytes);
  } catch (error) {
    if (error instanceof ImageMetadataError) throw new SponsorLogoRejectedError('UNREADABLE_IMAGE');
    throw error;
  }
  const asset = await uploadFile(db, storage, {
    purpose: 'SPONSOR_LOGO',
    bytes: clean.bytes,
    declaredMimeType: input.declaredMimeType,
    fileName: input.fileName,
    organizationId: input.organizationId,
    uploadedById: actor.userId
  });

  let previous: { bucket: string; objectKey: string } | null = null;
  try {
    previous = await inTransaction(db, async (tx) => {
      const current = await tx.sponsor.findUniqueOrThrow({ where: { id: input.sponsorId }, select: { status: true, logoFileId: true } });
      if (current.status !== 'PENDING' && current.status !== 'APPROVED') throw new SponsorLogoRejectedError('SPONSOR_NOT_ACTIVE');
      // Solo si nadie lo ha cambiado entretanto: dos subidas a la vez no dejan un fichero público sin dueño (la segunda falla y se retira su fichero).
      const { count } = await tx.sponsor.updateMany({ where: { id: input.sponsorId, logoFileId: current.logoFileId }, data: { logoFileId: asset.id } });
      if (count !== 1) throw new Error(`El logotipo del comercio ${input.sponsorId} ha cambiado mientras se subía otro.`);
      await recordAudit(tx, actor, { action: 'sponsor.logo_published', organizationId: input.organizationId, targetType: 'Sponsor', targetId: String(input.sponsorId), metadata: { fileId: asset.id, removedMetadata: clean.removed } }, { required: true });
      if (!current.logoFileId) return null;
      return tx.fileAsset.update({ where: { id: current.logoFileId }, data: { deletedAt: new Date() }, select: { bucket: true, objectKey: true } });
    });
  } catch (error) {
    await storage.remove(asset.bucket, asset.objectKey).catch(() => undefined);
    await db.fileAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } }).catch(() => undefined);
    throw error;
  }
  if (previous) await storage.remove(previous.bucket, previous.objectKey).catch(() => undefined);
  return { fileId: asset.id };
}
