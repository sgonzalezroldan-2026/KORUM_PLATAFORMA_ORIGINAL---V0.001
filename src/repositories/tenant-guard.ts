import type { Prisma } from '@/generated/prisma/client';
import type { MemberRole } from '@/generated/prisma/enums';
import type { KorumPrismaClient } from '@/lib/prisma';

/**
 * Guardia de aislamiento entre entidades (anti-IDOR), Regla 01 §4 y QA-SEC01.
 *
 * Principios:
 * - **Quién es y a qué entidades pertenece sale siempre de la sesión** (`SessionActor`, que construye la capa de
 *   autenticación del Sprint 3.2), nunca de lo que envía el cliente. El `organizationId` que llega por la URL o por un
 *   formulario es solo lo que se QUIERE consultar: la guardia comprueba que la sesión tiene derecho a ello.
 * - **Denegado por defecto:** sin membresía con un rol permitido (o sin ser Super-Admin) no se lee ni se escribe nada.
 * - **Todo intento denegado queda en `AuditLog`** (`tenant.access_denied`), y todo acceso del Super-Admin a una entidad
 *   (`superadmin.access`). Una denegación se deniega aunque falle la auditoría; un acceso del Super-Admin NO se concede
 *   si no se puede dejar constancia (falla cerrada). La escritura usa el cliente raíz: persiste aunque quien llama
 *   deshaga después su propia transacción.
 * - La auditoría guarda identificadores y una familia de navegador, nunca la IP en claro ni el `User-Agent` completo.
 */

export interface RequestMeta {
  /** HMAC de la IP (nunca la IP en claro). Se anonimiza al vencer su plazo de conservación. */
  ipHash?: string;
  userAgent?: string;
}

export interface Membership {
  organizationId: string;
  role: MemberRole;
}

export type SessionActor =
  | { kind: 'anonymous'; requestMeta?: RequestMeta }
  | {
      kind: 'user';
      userId: string;
      isSuperadmin: boolean;
      memberships: readonly Membership[];
      /** La sesión superó el segundo factor (TOTP o código de respaldo). Lo fija la capa de sesión; sin él no se firma (doble firma). */
      secondFactor?: boolean;
      requestMeta?: RequestMeta;
    }
  /** Sesión de portería abierta con el PIN de un evento: solo ve y valida **su** evento. */
  | { kind: 'gate'; gateSessionId: string; organizationId: string; initiativeId: number; requestMeta?: RequestMeta };

export type DenialReason =
  | 'ANONYMOUS'
  | 'NOT_A_MEMBER'
  | 'ROLE_NOT_ALLOWED'
  | 'GATE_SESSION_OTHER_TENANT'
  | 'GATE_SESSION_OTHER_EVENT'
  | 'GATE_SESSION_ROLE'
  | 'SUPERADMIN_EXCLUDED';

export type AccessDecision =
  | { allowed: true; via: 'MEMBER' | 'SUPERADMIN' | 'GATE_SESSION' }
  | { allowed: false; reason: DenialReason };

/** 403: la sesión no tiene derecho a esa entidad o a esa acción. */
export class TenantAccessError extends Error {
  readonly status = 403;
  readonly reason: DenialReason | 'SUPERADMIN_ONLY';

  constructor(reason: DenialReason | 'SUPERADMIN_ONLY') {
    super('No tienes acceso a esta entidad.');
    this.name = 'TenantAccessError';
    this.reason = reason;
  }
}

/** 404: el recurso no existe o no es de la entidad indicada (no se distingue, para no revelar que existe en otra). */
export class ResourceNotFoundError extends Error {
  readonly status = 404;

  constructor(resource: string) {
    super(`${resource} no encontrado.`);
    this.name = 'ResourceNotFoundError';
  }
}

export interface AccessTarget {
  targetType: string;
  targetId?: string | number;
}

export interface DecisionOptions {
  /** Sobre qué recurso se opera (una sesión de portería solo puede operar sobre su evento). */
  target?: AccessTarget;
  /** `false` para operaciones que ni el Super-Admin puede hacer por otra persona (p. ej. firmar una liquidación). */
  allowSuperadmin?: boolean;
}

/** Decisión pura de acceso (sin base de datos): fácil de probar y de razonar. */
export function decideTenantAccess(actor: SessionActor, organizationId: string, roles: readonly MemberRole[], options: DecisionOptions = {}): AccessDecision {
  switch (actor.kind) {
    case 'anonymous':
      return { allowed: false, reason: 'ANONYMOUS' };
    case 'gate': {
      if (actor.organizationId !== organizationId) return { allowed: false, reason: 'GATE_SESSION_OTHER_TENANT' };
      if (!roles.includes('GATEKEEPER')) return { allowed: false, reason: 'GATE_SESSION_ROLE' };
      const target = options.target;
      const ownEvent = target?.targetType === 'Initiative' && target.targetId !== undefined && Number(target.targetId) === actor.initiativeId;
      return ownEvent ? { allowed: true, via: 'GATE_SESSION' } : { allowed: false, reason: 'GATE_SESSION_OTHER_EVENT' };
    }
    case 'user': {
      if (actor.isSuperadmin) return options.allowSuperadmin === false ? { allowed: false, reason: 'SUPERADMIN_EXCLUDED' } : { allowed: true, via: 'SUPERADMIN' };
      const memberships = actor.memberships.filter((membership) => membership.organizationId === organizationId);
      if (memberships.length === 0) return { allowed: false, reason: 'NOT_A_MEMBER' };
      return memberships.some((membership) => roles.includes(membership.role)) ? { allowed: true, via: 'MEMBER' } : { allowed: false, reason: 'ROLE_NOT_ALLOWED' };
    }
  }
}

export interface GuardOptions extends AccessTarget {
  /** Roles que pueden hacer esta operación (el Super-Admin también, con registro, salvo `allowSuperadmin: false`). */
  roles: readonly MemberRole[];
  /** Nombre de la operación, p. ej. `initiative.list`. */
  action: string;
  allowSuperadmin?: boolean;
}

export interface AuditEntry {
  action: string;
  organizationId: string | null;
  targetType: string;
  targetId: string;
  metadata: Prisma.InputJsonObject;
}

/** Cliente (o transacción) con el que se puede escribir una fila de auditoría. */
export type AuditDb = Pick<KorumPrismaClient, 'auditLog'>;

const MAX_IDENTIFIER_LENGTH = 120;
const clip = (value: string | number): string => String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_IDENTIFIER_LENGTH);

/** Familia de navegador y sistema (`Chrome/Windows`): suficiente para investigar, sin la huella completa del `User-Agent`. */
export function coarseUserAgent(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /OPR\//.test(userAgent) ? 'Opera' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Otro';
  const system = /Windows NT/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : 'Otro';
  return `${browser}/${system}`;
}

/**
 * Escribe una fila de auditoría a nombre del actor. Con `required: true` un fallo se propaga (la operación no debe
 * continuar sin rastro); por defecto se registra en el servidor y no cambia el resultado (una denegación sigue siéndolo).
 */
export async function recordAudit(db: AuditDb, actor: SessionActor, entry: AuditEntry, options: { required?: boolean } = {}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorType: actor.kind === 'gate' ? 'GATE_SESSION' : 'USER',
        actorUserId: actor.kind === 'user' ? actor.userId : null,
        organizationId: entry.organizationId === null ? null : clip(entry.organizationId),
        action: entry.action,
        targetType: clip(entry.targetType),
        targetId: clip(entry.targetId),
        ipHash: actor.requestMeta?.ipHash?.slice(0, 128) ?? null,
        userAgent: coarseUserAgent(actor.requestMeta?.userAgent),
        metadataJson: entry.metadata
      }
    });
  } catch (error) {
    if (options.required) throw error;
    console.error('No se pudo escribir en AuditLog', entry.action, error);
  }
}

/** Datos del actor que se guardan en la auditoría: identificadores, nunca datos personales. */
function describeActor(actor: SessionActor): Prisma.InputJsonObject {
  if (actor.kind === 'user') return { actor: 'user', organizations: actor.memberships.map((membership) => `${membership.organizationId}:${membership.role}`) };
  if (actor.kind === 'gate') return { actor: 'gate', gateSessionId: actor.gateSessionId, organizationId: actor.organizationId, initiativeId: actor.initiativeId };
  return { actor: 'anonymous' };
}

/**
 * Comprueba que la sesión puede operar sobre `organizationId`. Si no, registra `tenant.access_denied` y lanza
 * `TenantAccessError` (403) SIN haber leído ni modificado ningún dato de esa entidad. Si es el Super-Admin, deja
 * `superadmin.access` (y si no puede dejarlo, no se concede). Se llama siempre ANTES de cualquier consulta.
 */
export async function authorizeTenant(db: KorumPrismaClient, actor: SessionActor, organizationId: string, options: GuardOptions): Promise<AccessDecision & { allowed: true }> {
  const decision = decideTenantAccess(actor, organizationId, options.roles, { target: options, allowSuperadmin: options.allowSuperadmin });
  const target = { targetType: options.targetType, targetId: String(options.targetId ?? organizationId) };

  if (!decision.allowed) {
    await recordAudit(db, actor, {
      action: 'tenant.access_denied',
      organizationId,
      ...target,
      metadata: { attempted: options.action, reason: decision.reason, requiredRoles: [...options.roles], ...describeActor(actor) }
    });
    throw new TenantAccessError(decision.reason);
  }
  if (decision.via === 'SUPERADMIN') {
    await recordAudit(db, actor, { action: 'superadmin.access', organizationId, ...target, metadata: { operation: options.action } }, { required: true });
  }
  return decision;
}

/** Operaciones exclusivas del Super-Admin (listados transversales): deniegan y registran a cualquier otra sesión. */
export async function authorizeSuperadmin(db: KorumPrismaClient, actor: SessionActor, action: string, targetType: string): Promise<void> {
  if (actor.kind === 'user' && actor.isSuperadmin) {
    await recordAudit(db, actor, { action: 'superadmin.access', organizationId: null, targetType, targetId: '*', metadata: { operation: action } }, { required: true });
    return;
  }
  await recordAudit(db, actor, {
    action: 'tenant.access_denied',
    organizationId: null,
    targetType,
    targetId: '*',
    metadata: { attempted: action, reason: 'SUPERADMIN_ONLY', ...describeActor(actor) }
  });
  throw new TenantAccessError('SUPERADMIN_ONLY');
}

export interface ResourceProbe {
  organizationId: string;
  resourceType: string;
  resourceId: string | number;
}

/** Registra un intento de usar el identificador de un recurso de OTRA entidad (para la detección de enumeración). */
export async function recordCrossTenantAttempt(db: KorumPrismaClient, actor: SessionActor, attempt: ResourceProbe & { ownerOrganizationId: string }): Promise<void> {
  await recordAudit(db, actor, {
    action: 'tenant.resource_outside_tenant',
    organizationId: attempt.organizationId,
    targetType: attempt.resourceType,
    targetId: String(attempt.resourceId),
    // El dueño real se guarda solo como identificador interno para la investigación; nunca se devuelve al cliente.
    metadata: { ownerOrganizationId: attempt.ownerOrganizationId, ...describeActor(actor) }
  });
}

/** Registra el sondeo de un identificador que no existe: así «existe en otra entidad» y «no existe» cuestan lo mismo. */
export async function recordMissingResourceProbe(db: KorumPrismaClient, actor: SessionActor, probe: ResourceProbe): Promise<void> {
  await recordAudit(db, actor, {
    action: 'tenant.resource_not_found',
    organizationId: probe.organizationId,
    targetType: probe.resourceType,
    targetId: String(probe.resourceId),
    metadata: { ...describeActor(actor) }
  });
}
