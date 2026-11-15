import { ANONYMOUS_AUTHOR_ACTIONS } from '@/core/audit/audit-catalog';
import type { Db } from '@/lib/db';

/**
 * Quién aparece en cada registro del visor de la auditoría (Sprint 5.8a). La auditoría guarda identificadores; el nombre se busca aquí, al enseñar la página.
 *
 * - **Consola:** nombre y email de la cuenta; si es del equipo de KORUM, se dice; una cuenta suprimida sale como tal, sin nombre.
 * - **Panel de la entidad:** solo se nombra, con su cargo, a quien firma **hoy** por ella. Quien firmó antes y fue relevado sale como «una persona que antes
 *   firmaba por la entidad», sin nombre (así una firma antigua no se confunde con la de una familia); KORUM, como «KORUM»; cualquier otra cuenta, como «otra
 *   persona». Lo que alguien hace como familia (escribir una consulta, votar) nunca lleva su nombre, aunque también firme por la entidad.
 */

export type AuditScope = { kind: 'console' } | { kind: 'entity'; organizationId: string };

export type AuditActorView =
  | { kind: 'system' }
  | { kind: 'webhook' }
  | { kind: 'gate' }
  | { kind: 'anonymous' }
  | { kind: 'korum'; name: string | null; email: string | null }
  | { kind: 'member'; name: string; roleLabel: string | null; role: string }
  | { kind: 'formerMember' }
  | { kind: 'person'; name: string | null; email: string | null }
  | { kind: 'other' }
  | { kind: 'erased' };

export interface AccountRow {
  id: string;
  name: string;
  email: string;
  isSuperadmin: boolean;
  gdprAnonymizedAt: Date | null;
}

export interface EntityMember {
  userId: string;
  name: string;
  role: string;
  roleLabel: string | null;
}

export async function loadAccounts(db: Db, userIds: string[]): Promise<Map<string, AccountRow>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true, isSuperadmin: true, gdprAnonymizedAt: true } });
  return new Map(rows.map((row) => [row.id, row]));
}

/** Quienes firman hoy por la entidad, con su cargo. `DIRECTOR` antes que `COSIGNER`; el resto de cargos (portería) no firma y no se nombra. */
export async function loadEntityMembers(db: Db, organizationId: string): Promise<EntityMember[]> {
  const rows = await db.organizationMember.findMany({
    where: { organizationId, role: { in: ['DIRECTOR', 'COSIGNER'] }, user: { gdprAnonymizedAt: null } },
    orderBy: { id: 'asc' },
    select: { userId: true, role: true, roleLabel: true, user: { select: { name: true } } }
  });
  const order = (role: string) => (role === 'DIRECTOR' ? 0 : 1);
  return rows.map((row) => ({ userId: row.userId, name: row.user.name, role: row.role, roleLabel: row.roleLabel })).sort((a, b) => order(a.role) - order(b.role));
}

/** Cuentas que firmaron por la entidad y fueron relevadas (relevos completados), menos las que hoy vuelven a firmar. */
export async function loadFormerSignerIds(db: Db, organizationId: string, current: readonly EntityMember[]): Promise<Set<string>> {
  const handovers = await db.signerHandover.findMany({ where: { organizationId, status: 'COMPLETED' }, select: { outgoingUserId: true } });
  const today = new Set(current.map((member) => member.userId));
  return new Set(handovers.map((handover) => handover.outgoingUserId).filter((userId) => !today.has(userId)));
}

/** Un periodo en el que una cuenta fue del equipo de KORUM. `to` vacío: lo sigue siendo. */
export interface KorumPeriod {
  from: Date;
  to: Date | null;
}
export type KorumPeriods = Map<string, KorumPeriod[]>;

const EPOCH = new Date(0);

/**
 * Cuándo fue cada cuenta del equipo de KORUM (auditoría de seguridad, tercera y cuarta pasada). Si una cuenta era o no de KORUM se juzga por la fecha de
 * cada fila, no por lo que sea hoy (el nombre y el cargo de quien firma sí se dan a quien firma hoy): si no, al retirar a alguien del equipo sus consultas pasadas aparecerían en el panel como «otra
 * persona»; y si esa persona firmara después por una entidad, lo que consultó como KORUM saldría con su nombre, o lo que haga ahora como firmante quedaría
 * oculto. Los periodos salen de la propia auditoría, que no se puede borrar: empiezan al aceptar la invitación de Super-Admin (o con el alta del primero) y
 * acaban con `superadmin.revoked`. Una cuenta que es Super-Admin sin que conste desde cuándo lo es «desde siempre» (ante la duda, se oculta).
 */
export async function loadKorumPeriods(db: Db): Promise<KorumPeriods> {
  // Una detrás de otra (ver `searchAudit`).
  const current = await db.user.findMany({ where: { isSuperadmin: true }, select: { id: true } });
  const events = await db.auditLog.findMany({
    where: {
      targetType: 'User',
      OR: [{ action: { in: ['superadmin.revoked', 'superadmin.bootstrapped'] } }, { action: 'account.invitation_accepted', metadataJson: { path: ['purpose'], equals: 'SUPERADMIN' } }]
    },
    orderBy: { id: 'asc' },
    select: { action: true, targetId: true, occurredAt: true }
  });
  const today = new Set(current.map((user) => user.id));
  const periods: KorumPeriods = new Map();
  const open = new Map<string, Date>();
  const lastEnd = new Map<string, Date>();
  const push = (userId: string, period: KorumPeriod) => periods.set(userId, [...(periods.get(userId) ?? []), period]);
  for (const event of events) {
    if (event.action === 'superadmin.revoked') {
      push(event.targetId, { from: open.get(event.targetId) ?? lastEnd.get(event.targetId) ?? EPOCH, to: event.occurredAt });
      open.delete(event.targetId);
      lastEnd.set(event.targetId, event.occurredAt);
    } else if (!open.has(event.targetId)) open.set(event.targetId, event.occurredAt);
  }
  // Un inicio sin baja posterior: sigue en el equipo (o dejó de estarlo sin que conste; se sigue ocultando).
  for (const [userId, from] of open) push(userId, { from, to: null });
  // Super-Admin de hoy sin inicio que conste (dado de alta directamente): desde su última baja o desde siempre.
  for (const userId of today) if (!open.has(userId)) push(userId, { from: lastEnd.get(userId) ?? EPOCH, to: null });
  return periods;
}

/** ¿Era esa cuenta del equipo de KORUM en ese instante? */
export const wasKorum = (periods: KorumPeriods, userId: string, at: Date): boolean => (periods.get(userId) ?? []).some((period) => at >= period.from && (period.to === null || at < period.to));

type RawActor = { actorType: string; actorUserId: string | null; action: string; occurredAt: Date };

function automaticActor(row: RawActor): AuditActorView | null {
  if (row.actorType === 'SYSTEM') return { kind: 'system' };
  if (row.actorType === 'WEBHOOK') return { kind: 'webhook' };
  if (row.actorType === 'GATE_SESSION') return { kind: 'gate' };
  if (!row.actorUserId) return { kind: 'anonymous' };
  return null;
}

export function consoleActor(row: RawActor, accounts: Map<string, AccountRow>): AuditActorView {
  const automatic = automaticActor(row);
  if (automatic) return automatic;
  const account = accounts.get(row.actorUserId!);
  if (!account || account.gdprAnonymizedAt) return { kind: 'erased' };
  const identity = { name: account.name || null, email: account.email };
  return account.isSuperadmin ? { kind: 'korum', ...identity } : { kind: 'person', ...identity };
}

export interface EntityPeople {
  members: Map<string, EntityMember>;
  former: Set<string>;
  /** Cuándo fue cada cuenta del equipo de KORUM (`loadKorumPeriods`). */
  korum: KorumPeriods;
}

export function entityActor(row: RawActor, people: EntityPeople): AuditActorView {
  const automatic = automaticActor(row);
  if (automatic) return automatic;
  // Lo que una persona hace como familia no lleva su nombre aunque también firme por la entidad.
  if (ANONYMOUS_AUTHOR_ACTIONS.has(row.action)) return { kind: 'other' };
  // Lo que alguien hizo siendo del equipo de KORUM es de KORUM, aunque hoy firme por la entidad; y lo que hizo sin serlo no lo es, aunque hoy sea del equipo.
  if (wasKorum(people.korum, row.actorUserId!, row.occurredAt)) return { kind: 'korum', name: null, email: null };
  const member = people.members.get(row.actorUserId!);
  if (member) return { kind: 'member', name: member.name, role: member.role, roleLabel: member.roleLabel };
  // De quien firmó antes, que firmaba; de cualquier otra cuenta, nada.
  return people.former.has(row.actorUserId!) ? { kind: 'formerMember' } : { kind: 'other' };
}
