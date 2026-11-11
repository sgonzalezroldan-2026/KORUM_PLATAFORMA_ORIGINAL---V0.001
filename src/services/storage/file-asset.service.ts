import { createHash, randomUUID } from 'node:crypto';
import { ImageMetadataError, stripImageMetadata } from '@/core/media/strip-image-metadata';
import type { FilePurpose } from '@/generated/prisma/enums';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeSuperadmin, authorizeTenant, decideTenantAccess, recordAudit, recordCrossTenantAttempt, ResourceNotFoundError, type SessionActor } from '@/repositories/tenant-guard';
import { detectFileType, extensionMatches, extensionOf, FILE_RULES } from './file-rules';
import { PRIVATE_BUCKET, PUBLIC_BUCKET, type StorageProvider } from './storage-provider';

/**
 * Ficheros de la plataforma (QA-OPS02, skill de pagos §3). Quien llama ya ha comprobado, con la sesión, que puede subir a esa entidad:
 * aquí solo se valida el contenido, se guarda en el cubo que corresponde al uso (público o privado) y se registra el `FileAsset` con su
 * huella SHA-256 y su tipo verificado. La clave del objeto la fabrica el servidor: el nombre que traiga quien sube no se usa.
 */

export type FileRejection = 'EMPTY' | 'TOO_LARGE' | 'UNRECOGNIZED_TYPE' | 'TYPE_NOT_ALLOWED' | 'MIME_MISMATCH' | 'EXTENSION_MISMATCH' | 'RETENTION_REQUIRED';

export class FileRejectedError extends Error {
  readonly reason: FileRejection;

  constructor(reason: FileRejection) {
    super(`Fichero rechazado: ${reason}.`);
    this.name = 'FileRejectedError';
    this.reason = reason;
  }
}

export interface UploadFileInput {
  purpose: FilePurpose;
  bytes: Uint8Array;
  /** El tipo que declara el navegador. Debe coincidir con el contenido. */
  declaredMimeType: string;
  fileName?: string;
  organizationId: string | null;
  uploadedById: string | null;
  /** Fecha hasta la que hay que conservarlo por ley. Obligatoria en facturas, KYB, certificados y Modelo 182 (`FILE_RULES.retentionRequired`). */
  retainUntil?: Date | null;
}

/** Una URL privada vive 5 minutos por defecto y nunca más de 15: se pide de nuevo cada vez que alguien abre el documento. */
export const DEFAULT_SIGNED_URL_SECONDS = 300;
export const MAX_SIGNED_URL_SECONDS = 900;

export async function uploadFile(db: Db, storage: StorageProvider, input: UploadFileInput) {
  const rule = FILE_RULES[input.purpose];
  if (input.bytes.length === 0) throw new FileRejectedError('EMPTY');
  if (rule.retentionRequired && !input.retainUntil) throw new FileRejectedError('RETENTION_REQUIRED');
  if (input.bytes.length > rule.maxBytes) throw new FileRejectedError('TOO_LARGE');
  const detected = detectFileType(input.bytes);
  if (!detected) throw new FileRejectedError('UNRECOGNIZED_TYPE');
  if (!rule.types.includes(detected)) throw new FileRejectedError('TYPE_NOT_ALLOWED');
  if (input.declaredMimeType.split(';')[0]?.trim().toLowerCase() !== detected) throw new FileRejectedError('MIME_MISMATCH');
  if (!extensionMatches(input.fileName, detected)) throw new FileRejectedError('EXTENSION_MISMATCH');

  // Toda imagen que va al cubo público sale sin metadatos, la suba quien la suba (heredado del Sprint 2.4): quien llama no puede olvidarlo. También
  // la foto de un documento del titular (auditoría del 4.2c): la del DNI hecha con el móvil llevaría la ubicación, que suele ser el domicilio.
  let body = input.bytes;
  // Y la foto de una factura de proveedor (Sprint 4.4a): hecha con el móvil en la obra, llevaría su ubicación.
  if (rule.visibility === 'PUBLIC' || ((input.purpose === 'KYB_DOCUMENT' || input.purpose === 'PROVIDER_INVOICE') && detected.startsWith('image/'))) {
    try {
      body = stripImageMetadata(input.bytes).bytes;
    } catch (error) {
      if (error instanceof ImageMetadataError) throw new FileRejectedError('UNRECOGNIZED_TYPE');
      throw error;
    }
  }

  const bucket = rule.visibility === 'PUBLIC' ? PUBLIC_BUCKET : PRIVATE_BUCKET;
  const objectKey = `${input.organizationId ?? 'platform'}/${input.purpose.toLowerCase()}/${randomUUID()}.${extensionOf(detected)}`;
  await storage.put({ bucket, objectKey, body, contentType: detected });
  try {
    return await db.fileAsset.create({
      data: {
        bucket,
        objectKey,
        visibility: rule.visibility,
        purpose: input.purpose,
        mimeType: detected,
        sizeBytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        organizationId: input.organizationId,
        uploadedById: input.uploadedById,
        retainUntil: input.retainUntil ?? null
      }
    });
  } catch (error) {
    // Sin fila no habría quien lo borrara nunca: se retira el objeto huérfano y se relanza el error original.
    await storage.remove(bucket, objectKey).catch(() => undefined);
    throw error;
  }
}

/**
 * URL para abrir un fichero. Los públicos (imágenes que la entidad publica) dan su URL permanente a cualquiera. Los privados pasan por la
 * guardia de entidades (Regla 01 §4): solo los roles de `FILE_RULES.readRoles` de **su** entidad, o el Super-Admin, y todo acceso denegado queda
 * en `AuditLog`. Quien no pertenece a la entidad recibe `404` y no `403`, para no revelar que el fichero existe. Un privado sin entidad solo lo
 * abre el Super-Admin. La URL firmada vive 5 minutos por defecto y nunca más de 15.
 */
export async function getFileUrl(db: KorumPrismaClient, storage: StorageProvider, actor: SessionActor, fileId: string, options: { expiresInSeconds?: number } = {}): Promise<string> {
  const asset = await db.fileAsset.findUnique({ where: { id: fileId } });
  if (!asset || asset.deletedAt) {
    await recordAudit(db, actor, { action: 'file.not_available', organizationId: null, targetType: 'FileAsset', targetId: fileId, metadata: {} });
    throw new ResourceNotFoundError('FileAsset');
  }
  if (asset.visibility === 'PUBLIC') return storage.publicUrl(asset.bucket, asset.objectKey);

  const target = { targetType: 'FileAsset', targetId: asset.id, action: 'file.read' };
  if (asset.organizationId === null) {
    await authorizeSuperadmin(db, actor, target.action, target.targetType);
  } else {
    const roles = FILE_RULES[asset.purpose].readRoles;
    const decision = decideTenantAccess(actor, asset.organizationId, roles);
    if (!decision.allowed && (decision.reason === 'NOT_A_MEMBER' || decision.reason === 'ANONYMOUS' || decision.reason === 'GATE_SESSION_OTHER_TENANT')) {
      await recordCrossTenantAttempt(db, actor, { organizationId: asset.organizationId, resourceType: target.targetType, resourceId: asset.id, ownerOrganizationId: asset.organizationId });
      throw new ResourceNotFoundError('FileAsset');
    }
    await authorizeTenant(db, actor, asset.organizationId, { roles, ...target });
  }
  // Un valor que no es un número (NaN, infinito) se trata como no indicado: nunca llega al almacén.
  const requested = options.expiresInSeconds !== undefined && Number.isFinite(options.expiresInSeconds) ? options.expiresInSeconds : DEFAULT_SIGNED_URL_SECONDS;
  const seconds = Math.min(Math.max(1, Math.floor(requested)), MAX_SIGNED_URL_SECONDS);
  return storage.createSignedUrl(asset.bucket, asset.objectKey, seconds);
}
