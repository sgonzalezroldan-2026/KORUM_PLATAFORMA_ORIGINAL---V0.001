import { ENTITY_DOSSIER_KINDS, type DossierData, type DossierKind, type DossierRequest } from '@/core/dossier/dossier-model';
import type { Db } from '@/lib/db';
import type { KorumPrismaClient } from '@/lib/prisma';
import { reserveAttempt } from '@/lib/rate-limit';
import { DOSSIER_RULE } from '@/lib/rate-limit-rules';
import { authorizeConsoleSession } from '@/services/admin/console-alerts.service';
import { findDossierSubject, loadDossier, type DossierSubject } from '@/services/dossier/dossier.service';
import { authorizeTenant, recordAudit, recordCrossTenantAttempt, recordMissingResourceProbe, TenantAccessError, type SessionActor } from './tenant-guard';

/**
 * Expediente exportable (Sprint 5.8b): quién puede descargar qué.
 *
 * - **Consola** (`{ scope: 'console' }`): el Super-Admin con el segundo factor de su sesión, de cualquier entidad: una aportación, una campaña o una liquidación.
 * - **Panel de la entidad** (`{ scope: 'entity', organizationId }`): quien firma por esa entidad (`DIRECTOR` o `COSIGNER`) con el segundo factor, y solo de
 *   **sus** campañas y liquidaciones. El Super-Admin no entra por aquí: tiene la consola. El de una aportación no existe para la entidad (las aportaciones
 *   son anónimas para ella). Un identificador de otra entidad responde exactamente igual que uno que no existe; la auditoría sí los distingue.
 *
 * Cada petición de una cuenta cuenta para su tope por hora (`DOSSIER_RULE`) **antes** de leer o de anotar nada. Cada descarga queda en `AuditLog`
 * (`dossier.downloaded`) antes de entregar el PDF: si no se puede anotar, no se entrega. Los datos se leen en una transacción de solo lectura con una
 * misma foto de la base (`RepeatableRead`), para que la ficha y el libro mayor sean del mismo instante.
 */

export type DossierAccess = { scope: 'console' } | { scope: 'entity'; organizationId: string };

/** Demasiadas peticiones de expedientes de esa cuenta en la última hora. */
export class DossierRateLimitError extends Error {
  readonly status = 429;
  constructor() {
    super('Demasiados expedientes pedidos en poco tiempo.');
    this.name = 'DossierRateLimitError';
  }
}

const RESOURCE_TYPE: Record<DossierKind, string> = { contribution: 'Contribution', initiative: 'Initiative', payout: 'EscrowPayout' };

/**
 * Comprueba el tope y el acceso, y busca el objeto. `null`: no existe, no es de esa entidad o la entidad no puede pedir ese tipo (no se distingue). Lanza
 * `TenantAccessError` si la sesión no tiene derecho a esa entidad o a la consola, y `DossierRateLimitError` si la cuenta ha pedido demasiados.
 */
export async function resolveDossier(db: KorumPrismaClient, actor: SessionActor, access: DossierAccess, request: DossierRequest): Promise<DossierSubject | null> {
  if (actor.kind === 'user' && !(await reserveAttempt(db, `${DOSSIER_RULE.prefix}${actor.userId}`, DOSSIER_RULE))) throw new DossierRateLimitError();
  if (access.scope === 'console') {
    await authorizeConsoleSession(db, actor, 'console.dossier', RESOURCE_TYPE[request.kind]);
    return findDossierSubject(db, request);
  }
  const { organizationId } = access;
  if (actor.kind === 'user' && actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: 'dossier.read' } });
    throw new TenantAccessError('ROLE_NOT_ALLOWED');
  }
  await authorizeTenant(db, actor, organizationId, { roles: ['DIRECTOR', 'COSIGNER'], action: 'dossier.read', targetType: 'Organization', allowSuperadmin: false });
  if (!ENTITY_DOSSIER_KINDS.includes(request.kind)) {
    await recordAudit(db, actor, { action: 'api.panel_dossier_denied', organizationId, targetType: 'Organization', targetId: organizationId, metadata: { reason: 'KIND_NOT_ALLOWED', kind: request.kind } });
    return null;
  }
  const subject = await findDossierSubject(db, request);
  if (subject && subject.organizationId === organizationId) return subject;
  // La misma respuesta exista o no, sea o no de otra entidad; la auditoría sí lo distingue.
  const probe = { organizationId, resourceType: RESOURCE_TYPE[request.kind], resourceId: request.ref.by === 'id' ? request.ref.id : '*' };
  if (subject) await recordCrossTenantAttempt(db, actor, { ...probe, ownerOrganizationId: subject.organizationId });
  else await recordMissingResourceProbe(db, actor, probe);
  return null;
}

/** Los datos del expediente, con la descarga ya anotada. `null` con el mismo significado que en `resolveDossier`. */
export async function downloadDossier(db: KorumPrismaClient, actor: SessionActor, access: DossierAccess, request: DossierRequest, now: Date = new Date()): Promise<DossierData | null> {
  const subject = await resolveDossier(db, actor, access, request);
  if (!subject) return null;
  const data = await db.$transaction((tx) => loadDossier(tx as unknown as Db, access.scope, subject, now), { isolationLevel: 'RepeatableRead', maxWait: 10_000, timeout: 30_000 });
  await recordAudit(
    db,
    actor,
    { action: 'dossier.downloaded', organizationId: subject.organizationId, targetType: RESOURCE_TYPE[subject.kind], targetId: String(subject.id), metadata: { kind: subject.kind, scope: access.scope, initiativeId: subject.initiativeId } },
    { required: true }
  );
  return data;
}

/** Lo que una entidad puede elegir en su panel: sus campañas y, de ellas, las que tienen liquidación. La guardia ya la pasó la página. */
export async function listEntityDossierOptions(db: KorumPrismaClient, organizationId: string): Promise<Array<{ initiativeId: number; title: string; payoutId: number | null }>> {
  const rows = await db.initiative.findMany({ where: { organizationId }, orderBy: { id: 'desc' }, take: 500, select: { id: true, title: true, payout: { select: { id: true } } } });
  return rows.map((row) => ({ initiativeId: row.id, title: row.title, payoutId: row.payout?.id ?? null }));
}
