import { canEditKyb, kybIdentitySchema, kybReadiness, kybRetainUntil, type KybDocumentKind } from '@/core/panel/entity-settings-rules';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { inTransaction, isUniqueViolation, type Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { KYB_UPLOAD_RULE } from '@/lib/rate-limit-rules';
import { authorizeTenant, recordAudit, ResourceNotFoundError, TenantAccessError, type SessionActor } from '@/repositories/tenant-guard';
import { getFileUrl, uploadFile } from '@/services/storage/file-asset.service';
import type { StorageProvider } from '@/services/storage/storage-provider';

/**
 * Documentos del titular (KYB, Sprint 4.2c · QA-S02). Los suben las personas firmantes de **su** entidad, con el segundo factor superado en esta
 * sesión; el Super-Admin no los sube en su nombre (los revisa en su consola, Sprint 5.2). Cada documento va al cubo privado (`KYB_DOCUMENT`) con
 * su plazo legal, y sustituir uno lo deja de vigente sin borrarlo. Mientras KORUM los revisa o ya los ha verificado no se cambian desde aquí.
 *
 * Cada operación bloquea primero la fila de la entidad con una escritura condicional (`kybStatus` editable): una subida y un envío a revisión a
 * la vez se ordenan, y el envío nunca deja fuera un documento que se estaba subiendo.
 */

export type KybRejection = 'LOCKED' | 'NOT_REQUIRED' | 'INCOMPLETE' | 'INVALID' | 'CIF_IN_USE' | 'RATE_LIMITED';

export class KybRejectedError extends Error {
  constructor(
    readonly reason: KybRejection,
    readonly fields: string[] = []
  ) {
    super(`No se puede completar la operación del KYB: ${reason}.`);
    this.name = 'KybRejectedError';
  }
}

/** Solo firmantes de esta entidad con el segundo factor (nunca el Super-Admin en su nombre); lo denegado queda en `AuditLog`. */
export async function requireSigner(db: KorumPrismaClient, actor: SessionActor, organizationId: string, action: string): Promise<Extract<SessionActor, { kind: 'user' }>> {
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: action } });
    throw new TenantAccessError(actor.kind === 'user' ? 'ROLE_NOT_ALLOWED' : 'ANONYMOUS');
  }
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action, targetType: 'Organization', targetId: organizationId, allowSuperadmin: false });
  return actor;
}

/**
 * Antes de leer el fichero (la ruta lo llama sin haber leído el cuerpo): cargo en la entidad con segundo factor y tope de subidas por entidad, porque
 * cada sustitución se conserva 6 años (auditoría del 4.2c).
 */
export async function authorizeKybUpload(db: KorumPrismaClient, actor: SessionActor, organizationId: string, now: Date = new Date()): Promise<void> {
  await requireSigner(db, actor, organizationId, 'kyb.document_upload');
  if (!(await reserveAttempt(db, `${KYB_UPLOAD_RULE.prefix}${organizationId}`, KYB_UPLOAD_RULE, now))) throw new KybRejectedError('RATE_LIMITED');
}

/** Bloquea la fila de la entidad si su KYB se puede editar. Devuelve `false` si no (en revisión o verificado). */
async function lockEditable(tx: Db, organizationId: string, now: Date): Promise<boolean> {
  const { count } = await tx.organization.updateMany({ where: { id: organizationId, kybStatus: { in: ['PENDING', 'REJECTED'] } }, data: { updatedAt: now } });
  return count === 1;
}

export interface UploadKybDocumentInput {
  organizationId: string;
  kind: KybDocumentKind;
  bytes: Uint8Array;
  declaredMimeType: string;
  fileName: string;
}

export async function uploadKybDocument(db: KorumPrismaClient, storage: StorageProvider, actor: SessionActor, input: UploadKybDocumentInput, now: Date = new Date()): Promise<{ documentId: number }> {
  const signer = await requireSigner(db, actor, input.organizationId, 'kyb.document_upload');
  const organization = await db.organization.findUnique({ where: { id: input.organizationId }, select: { kybStatus: true, ley49: true } });
  if (!organization) throw new ResourceNotFoundError('Entidad');
  if (!canEditKyb(organization.kybStatus)) throw new KybRejectedError('LOCKED');
  if (input.kind === 'LEY49_ACCREDITATION' && !organization.ley49) throw new KybRejectedError('NOT_REQUIRED');

  // Se sube antes de abrir la transacción (el almacén es externo); si algo falla después, se retira el fichero.
  const asset = await uploadFile(db, storage, {
    purpose: 'KYB_DOCUMENT',
    bytes: input.bytes,
    declaredMimeType: input.declaredMimeType,
    fileName: input.fileName,
    organizationId: input.organizationId,
    uploadedById: signer.userId,
    retainUntil: kybRetainUntil(now)
  });
  try {
    return await inTransaction(db, async (tx) => {
      if (!(await lockEditable(tx, input.organizationId, now))) throw new KybRejectedError('LOCKED');
      const current = await tx.kybDocument.findFirst({ where: { organizationId: input.organizationId, kind: input.kind, replacedAt: null }, select: { id: true, fileId: true } });
      if (current) {
        await tx.kybDocument.update({ where: { id: current.id }, data: { replacedAt: now } });
        // Deja de ser el vigente: desde hoy corre su plazo legal (la purga no toca los vigentes de una entidad activa).
        await tx.fileAsset.update({ where: { id: current.fileId }, data: { retainUntil: kybRetainUntil(now) } });
      }
      const document = await tx.kybDocument.create({ data: { organizationId: input.organizationId, kind: input.kind, fileId: asset.id, uploadedById: signer.userId, createdAt: now }, select: { id: true } });
      await recordAudit(
        tx,
        signer,
        { action: 'kyb.document_uploaded', organizationId: input.organizationId, targetType: 'KybDocument', targetId: String(document.id), metadata: { kind: input.kind, fileId: asset.id, replacedDocumentId: current?.id ?? null } },
        { required: true }
      );
      return { documentId: document.id };
    });
  } catch (error) {
    await storage.remove(asset.bucket, asset.objectKey).catch(() => undefined);
    await db.fileAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } }).catch(() => undefined);
    if (isUniqueViolation(error)) throw new KybRejectedError('LOCKED');
    throw error;
  }
}

/** Razón social y CIF del titular. Solo antes de enviarlos o tras una devolución; el CIF no puede ser el de otra entidad de KORUM. */
export async function saveKybIdentity(db: KorumPrismaClient, actor: SessionActor, organizationId: string, raw: unknown, now: Date = new Date()): Promise<{ legalName: string; cif: string }> {
  const signer = await requireSigner(db, actor, organizationId, 'kyb.identity_update');
  const parsed = kybIdentitySchema.safeParse(raw);
  if (!parsed.success) throw new KybRejectedError('INVALID', [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'form')))]);
  const { legalName, cif } = parsed.data;
  try {
    await inTransaction(db, async (tx) => {
      // Primero el bloqueo y después el «antes»: con dos guardados a la vez, la auditoría de cada uno dice lo que había de verdad.
      if (!(await lockEditable(tx, organizationId, now))) throw new KybRejectedError('LOCKED');
      const before = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { legalName: true, cif: true } });
      await tx.organization.update({ where: { id: organizationId }, data: { legalName, cif } });
      await recordAudit(
        tx,
        signer,
        { action: 'kyb.identity_updated', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { legalNameBefore: before.legalName, legalNameAfter: legalName, cifChanged: before.cif !== cif } },
        { required: true }
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new KybRejectedError('CIF_IN_USE', ['cif']);
    throw error;
  }
  return { legalName, cif };
}

/** Envía los documentos a revisión (`SUBMITTED`): todos los que tocan y el CIF del titular. Borra la nota de una devolución anterior. */
export async function submitKyb(db: KorumPrismaClient, actor: SessionActor, organizationId: string, now: Date = new Date()): Promise<void> {
  const signer = await requireSigner(db, actor, organizationId, 'kyb.submit');
  await inTransaction(db, async (tx) => {
    if (!(await lockEditable(tx, organizationId, now))) throw new KybRejectedError('LOCKED');
    const [organization, documents] = await Promise.all([
      tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { ley49: true, cif: true, kybStatus: true } }),
      tx.kybDocument.findMany({ where: { organizationId, replacedAt: null }, select: { kind: true } })
    ]);
    const readiness = kybReadiness({ ley49: organization.ley49, cif: organization.cif, currentKinds: documents.map((document) => document.kind) });
    if (!readiness.ready) throw new KybRejectedError('INCOMPLETE', [...readiness.missing, ...(readiness.missingTaxId ? ['cif'] : [])]);
    await tx.organization.update({ where: { id: organizationId }, data: { kybStatus: 'SUBMITTED', kybSubmittedAt: now, kybReviewNote: null } });
    await recordAudit(
      tx,
      signer,
      { action: 'kyb.submitted', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { from: organization.kybStatus, documents: documents.map((document) => document.kind) } },
      { required: true }
    );
  });
}

/**
 * Enlace de corta duración para abrir un documento vigente o sustituido de la entidad. La guardia de ficheros (`getFileUrl`) vuelve a comprobar
 * el cargo; aquí además se exige el segundo factor y que el documento sea de esta entidad (un identificador de otra responde igual que uno que no
 * existe). Cada apertura queda en la auditoría: hay un DNI entre ellos (auditoría del 4.2c).
 */
export async function openKybDocument(db: KorumPrismaClient, storage: StorageProvider, actor: SessionActor, organizationId: string, documentId: number): Promise<string> {
  if (actor.kind !== 'user' || actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, targetType: 'KybDocument', targetId: String(documentId), metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: 'kyb.document_open' } });
    throw new TenantAccessError(actor.kind === 'user' ? 'ROLE_NOT_ALLOWED' : 'ANONYMOUS');
  }
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'kyb.document_open', targetType: 'KybDocument', targetId: documentId });
  const document = await db.kybDocument.findFirst({ where: { id: documentId, organizationId }, select: { fileId: true, kind: true } });
  if (!document) {
    await recordAudit(db, actor, { action: 'kyb.document_not_found', organizationId, targetType: 'KybDocument', targetId: String(documentId), metadata: {} });
    throw new ResourceNotFoundError('KybDocument');
  }
  const url = await getFileUrl(db, storage, actor, document.fileId);
  await recordAudit(db, actor, { action: 'kyb.document_opened', organizationId, targetType: 'KybDocument', targetId: String(documentId), metadata: { kind: document.kind } }, { required: true });
  return url;
}
