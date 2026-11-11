import { CampaignPayoutError } from '@/core/payouts/campaign-payout-rules';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { KorumPrismaClient } from '@/lib/prisma';
import { findPayoutInvoice } from '@/repositories/campaign-payout.repository';
import { authorizeTenant, recordAudit, recordCrossTenantAttempt, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { getFileUrl, uploadFile } from '@/services/storage/file-asset.service';
import type { StorageProvider } from '@/services/storage/storage-provider';
import { authorizePayoutAction, reservePayoutAttempt } from './campaign-payout.service';

/**
 * Factura (o proforma) del proveedor de una campaña (Sprint 4.4a). Se sube antes de pedir la liquidación y queda privada: solo la abren quienes firman en
 * la entidad (y el Super-Admin, con registro). Subirla no la adjunta a nada: es al pedir la liquidación cuando se elige, y entonces su contenido (SHA-256)
 * entra en lo que firman las dos personas y se conserva 6 años como justificante (CUMPLIMIENTO §6). Sin adjuntar, se borra a los 30 días (I2).
 */

/** 4 MB de fichero: el cuerpo de una función de Vercel no pasa de 4,5 MB (heredado del 4.2c). Para más, subida directa al almacén (6.1). */
export const MAX_INVOICE_BYTES = 4 * 1024 * 1024;
/** Una factura subida que no llega a adjuntarse a ninguna liquidación (DATA_RETENTION_PURGE la borra después). */
export const UNATTACHED_INVOICE_DAYS = 30;

export interface UploadInvoiceInput {
  organizationId: string;
  initiativeId: number;
  bytes: Uint8Array;
  declaredMimeType: string;
  fileName?: string;
}

export async function uploadPayoutInvoice(db: KorumPrismaClient, storage: StorageProvider, actor: SessionActor, input: UploadInvoiceInput, now: Date = new Date()): Promise<{ fileId: string }> {
  const user = await authorizePayoutAction(db, actor, input.organizationId, 'payout.invoice_upload', input.initiativeId);
  const initiative = await db.initiative.findUniqueOrThrow({ where: { id: input.initiativeId }, select: { status: true } });
  if (initiative.status !== 'GOAL_REACHED') throw new CampaignPayoutError('NOT_READY');
  await reservePayoutAttempt(db, actor, input.organizationId, 'invoice', now);
  // `uploadFile` valida el tipo real, el tamaño y la extensión, y quita los metadatos de una foto de la factura.
  const asset = await uploadFile(db, storage, {
    purpose: 'PROVIDER_INVOICE',
    bytes: input.bytes,
    declaredMimeType: input.declaredMimeType,
    fileName: input.fileName,
    organizationId: input.organizationId,
    uploadedById: user.userId,
    retainUntil: new Date(now.getTime() + UNATTACHED_INVOICE_DAYS * 86_400_000)
  });
  await recordAudit(db, actor, { action: 'payout.invoice_uploaded', organizationId: input.organizationId, targetType: 'FileAsset', targetId: asset.id, metadata: { initiativeId: input.initiativeId, sizeBytes: input.bytes.length } }, { required: true });
  return { fileId: asset.id };
}

/** URL firmada de 5 minutos para abrir una factura de proveedor de esta entidad. Una de otra entidad responde igual que una que no existe, y queda registrada. */
export async function openPayoutInvoice(db: KorumPrismaClient, storage: StorageProvider, actor: SessionActor, organizationId: string, fileId: string, now: Date = new Date()): Promise<string> {
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, targetType: 'FileAsset', targetId: fileId, metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: 'payout.invoice_open' } });
    throw new TenantAccessError(actor.kind === 'user' ? 'ROLE_NOT_ALLOWED' : 'ANONYMOUS');
  }
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'payout.invoice_open', targetType: 'FileAsset', targetId: fileId });
  // Cada apertura deja una fila de auditoría y una URL firmada: con límite por persona (auditoría de seguridad del 4.4a, M2).
  await reservePayoutAttempt(db, actor, organizationId, 'open', now);
  const { file, ownerOrganizationId } = await findPayoutInvoice(db, organizationId, fileId);
  if (!file) {
    if (ownerOrganizationId) await recordCrossTenantAttempt(db, actor, { organizationId, resourceType: 'FileAsset', resourceId: fileId, ownerOrganizationId });
    throw new ResourceNotFoundError('FileAsset');
  }
  const url = await getFileUrl(db, storage, actor, file.id, { expiresInSeconds: 300 });
  await recordAudit(db, actor, { action: 'payout.invoice_opened', organizationId, targetType: 'FileAsset', targetId: file.id, metadata: {} }, { required: true });
  return url;
}
