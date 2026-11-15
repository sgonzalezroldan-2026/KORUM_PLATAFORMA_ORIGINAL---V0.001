import { auditDateRange, type AuditQuery } from '@/core/audit/audit-query';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeConsoleSession } from '@/services/admin/console-alerts.service';
import { describeAccount, findAccountIdByEmail, loadEntityMembers, searchAudit, type AuditPage } from '@/services/audit/audit-viewer.service';
import { authorizeTenant, recordAudit, TenantAccessError, type SessionActor } from './tenant-guard';

/**
 * Visor de la auditoría (Sprint 5.8a): quién hizo qué, cuándo y desde dónde.
 *
 * - **Consola** (`getConsoleAudit`): solo el Super-Admin con el segundo factor de su sesión; abrirla queda en `superadmin.access`, como el resto de la consola.
 * - **Panel de la entidad** (`getEntityAudit`): solo quien firma por esa entidad (`DIRECTOR` o `COSIGNER`), con el segundo factor. La entidad sale de la
 *   sesión y de la ruta ya comprobada, y **toda** la consulta lleva su `organizationId`: los filtros que llegan del navegador (persona, iniciativa) solo
 *   pueden estrechar lo que ya es suyo. Lo que ve cada alcance lo decide `audit-viewer.service.ts`.
 */

const OPTIONS_LIMIT = 500;

export interface ConsoleAuditView {
  page: AuditPage;
  organizations: Array<{ id: string; name: string }>;
  /** La cuenta del filtro «persona», si lo hay: `null` si ese identificador no es de ninguna cuenta. */
  person: { userId: string; name: string | null; email: string | null; erased: boolean } | null;
  personNotFound: boolean;
}

export async function getConsoleAudit(db: KorumPrismaClient, actor: SessionActor, query: AuditQuery): Promise<ConsoleAuditView> {
  await authorizeConsoleSession(db, actor, 'console.audit', 'AuditLog');
  const [page, organizations, account] = await Promise.all([
    searchAudit(db, { kind: 'console' }, { ...query, ...auditDateRange(query) }),
    db.organization.findMany({ orderBy: { name: 'asc' }, take: OPTIONS_LIMIT, select: { id: true, name: true } }),
    query.personUserId ? describeAccount(db, query.personUserId) : Promise.resolve(null)
  ]);
  return { page, organizations, person: query.personUserId && account ? { userId: query.personUserId, ...account } : null, personNotFound: Boolean(query.personUserId) && !account };
}

/** Traduce un email a la cuenta que lo tiene, para buscar por persona. Solo el Super-Admin; el email no se guarda ni se anota. */
export async function resolveAuditPerson(db: KorumPrismaClient, actor: SessionActor, email: string): Promise<string | null> {
  await authorizeConsoleSession(db, actor, 'console.audit_person_lookup', 'AuditLog');
  return findAccountIdByEmail(db, email);
}

export interface EntityAuditView {
  page: AuditPage;
  /** Quienes firman hoy por la entidad: las únicas personas por las que se puede filtrar. */
  members: Array<{ userId: string; name: string; role: string; roleLabel: string | null }>;
  initiatives: Array<{ id: number; title: string }>;
  /** Los filtros que de verdad se aplicaron (una persona que no firma por la entidad se descarta). */
  applied: AuditQuery;
}

export async function getEntityAudit(db: KorumPrismaClient, actor: SessionActor, organizationId: string, query: AuditQuery): Promise<EntityAuditView> {
  if (actor.kind === 'user' && actor.secondFactor !== true) {
    await recordAudit(db, actor, { action: 'tenant.access_denied', organizationId, targetType: 'AuditLog', targetId: organizationId, metadata: { reason: 'SECOND_FACTOR_REQUIRED', attempted: 'audit.read' } });
    throw new TenantAccessError('ROLE_NOT_ALLOWED');
  }
  await authorizeTenant(db, actor, organizationId, { roles: ['DIRECTOR', 'COSIGNER'], action: 'audit.read', targetType: 'AuditLog' });
  const [members, initiatives] = await Promise.all([
    loadEntityMembers(db, organizationId),
    db.initiative.findMany({ where: { organizationId }, orderBy: { id: 'desc' }, take: OPTIONS_LIMIT, select: { id: true, title: true } })
  ]);
  const applied: AuditQuery = { ...query, organizationId: undefined, personUserId: query.personUserId && members.some((member) => member.userId === query.personUserId) ? query.personUserId : undefined };
  const page = await searchAudit(db, { kind: 'entity', organizationId }, { ...applied, ...auditDateRange(applied) });
  return { page, members, initiatives, applied };
}
