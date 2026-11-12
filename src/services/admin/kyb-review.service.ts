import { kybReviewSchema, ley49Outcome } from '@/core/admin/org-360-rules';
import { notifySigners } from '@/core/jobs/notify';
import { kybReadiness } from '@/core/panel/entity-settings-rules';
import { assertVerifiedSuperadmin, revalidateActor, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { inTransaction, isUniqueViolation, type Db } from '@/lib/db';

/**
 * Revisión del KYB por el Super-Admin (Sprint 5.2, heredado del 4.2c): **verificar** los documentos de una entidad (y, si la declaró, su régimen de la
 * Ley 49/2002) o **devolverlos** con una nota sin datos personales. Exigen el Super-Admin verificado (TOTP de hace menos de 10 minutos). Cada decisión
 * cambia el estado con una escritura condicional (`SUBMITTED` → …): dos personas a la vez, o un doble clic, solo decide una. Las dos avisan por email a
 * quienes firman (`org.kybStatus`, EXPERIENCIA §4) y quedan en la auditoría. Abrir un documento lo hace el Super-Admin con `openKybDocument` (ya admitido,
 * con registro de cada apertura).
 */

export type KybReviewRejection = 'NOT_FOUND' | 'NOT_SUBMITTED' | 'INVALID' | 'INCOMPLETE' | 'LEY49_NOT_DECLARED' | 'SPLIT_ID_IN_USE';

export class KybReviewRejectedError extends Error {
  constructor(
    readonly reason: KybReviewRejection,
    readonly fields: string[] = []
  ) {
    super(`No se puede revisar el KYB de la entidad: ${reason}.`);
    this.name = 'KybReviewRejectedError';
  }
}

export interface KybReviewResult {
  decision: 'VERIFIED' | 'REJECTED';
  cifReleased: boolean;
}

export async function reviewKyb(db: Db, actor: VerifiedSuperadminActor, organizationId: string, raw: unknown, now: Date = new Date()): Promise<KybReviewResult> {
  assertVerifiedSuperadmin(actor, 'kyb.review', now);
  const parsed = kybReviewSchema.safeParse(raw);
  if (!parsed.success) throw new KybReviewRejectedError('INVALID', [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'form')))]);
  const input = parsed.data;
  try {
    return await inTransaction(db, async (tx): Promise<KybReviewResult> => {
      await revalidateActor(tx, actor, 'kyb.review', now);
      // Solo se decide lo que está esperando revisión: la condición va en la escritura, no en una lectura previa.
      const { count } = await tx.organization.updateMany({ where: { id: organizationId, archivedAt: null, kybStatus: 'SUBMITTED' }, data: { updatedAt: now } });
      if (count === 0) {
        const exists = await tx.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
        throw new KybReviewRejectedError(exists ? 'NOT_SUBMITTED' : 'NOT_FOUND');
      }
      const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { ley49: true, cif: true, kybSubmittedAt: true } });
      const reviewer = { kybReviewedAt: now, kybReviewedById: actor.userId };

      if (input.decision === 'VERIFIED') {
        const documents = await tx.kybDocument.findMany({ where: { organizationId, replacedAt: null }, select: { kind: true } });
        if (!kybReadiness({ ley49: organization.ley49, cif: organization.cif, currentKinds: documents.map((document) => document.kind) }).ready) throw new KybReviewRejectedError('INCOMPLETE');
        if (input.ley49Accredited && !organization.ley49) throw new KybReviewRejectedError('LEY49_NOT_DECLARED', ['ley49Accredited']);
        await tx.organization.update({
          where: { id: organizationId },
          data: { kybStatus: 'VERIFIED', ...reviewer, kybReviewNote: null, ...(input.ley49Accredited ? { ley49VerifiedAt: now } : {}), ...(input.paycometSplitId ? { paycometSplitId: input.paycometSplitId } : {}) }
        });
        const ley49 = ley49Outcome(organization.ley49, input.ley49Accredited);
        await notifySigners(tx, organizationId, 'org.kybStatus', `verified:${now.getTime()}`, { stage: 'VERIFIED', ley49 });
        await tx.auditLog.create({
          data: { actorType: 'USER', actorUserId: actor.userId, organizationId, action: 'kyb.verified', targetType: 'Organization', targetId: organizationId, metadataJson: { ley49, splitIdSet: input.paycometSplitId !== undefined } }
        });
        return { decision: 'VERIFIED', cifReleased: false };
      }

      // Devolver: la entidad corrige y vuelve a enviar. Con `releaseCif` se libera el CIF escrito (alguien pudo teclear el de otra entidad que aún no está en KORUM).
      await tx.organization.update({ where: { id: organizationId }, data: { kybStatus: 'REJECTED', ...reviewer, kybReviewNote: input.note, ...(input.releaseCif ? { cif: null } : {}) } });
      await notifySigners(tx, organizationId, 'org.kybStatus', `rejected:${now.getTime()}`, { stage: 'REJECTED', note: input.note });
      await tx.auditLog.create({
        data: { actorType: 'USER', actorUserId: actor.userId, organizationId, action: 'kyb.rejected', targetType: 'Organization', targetId: organizationId, metadataJson: { cifReleased: input.releaseCif, noteLength: input.note.length } }
      });
      return { decision: 'REJECTED', cifReleased: input.releaseCif };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new KybReviewRejectedError('SPLIT_ID_IN_USE', ['paycometSplitId']);
    throw error;
  }
}

/**
 * Libera el CIF de una entidad que aún no está verificada (heredado del 4.2c, «CIF ocupado»): una entidad pudo escribir el CIF de otra que todavía no está
 * en KORUM y bloquear su alta (`CIF_IN_USE`). Sin el CIF la entidad no puede enviar su revisión hasta escribir el suyo. Una verificada no se toca.
 */
export async function releaseOrganizationCif(db: Db, actor: VerifiedSuperadminActor, organizationId: string, now: Date = new Date()): Promise<void> {
  assertVerifiedSuperadmin(actor, 'kyb.release_cif', now);
  await inTransaction(db, async (tx) => {
    await revalidateActor(tx, actor, 'kyb.release_cif', now);
    const { count } = await tx.organization.updateMany({ where: { id: organizationId, archivedAt: null, kybStatus: { not: 'VERIFIED' }, cif: { not: null } }, data: { cif: null, updatedAt: now } });
    if (count === 0) throw new KybReviewRejectedError((await tx.organization.findUnique({ where: { id: organizationId }, select: { id: true } })) ? 'NOT_SUBMITTED' : 'NOT_FOUND');
    await tx.auditLog.create({ data: { actorType: 'USER', actorUserId: actor.userId, organizationId, action: 'kyb.cif_released', targetType: 'Organization', targetId: organizationId, metadataJson: {} } });
  });
}
