import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { KorumPrismaClient } from '@/lib/prisma';
import { authorizeTenant, type SessionActor } from './tenant-guard';

/**
 * Datos de la pantalla «Taquilla y portería» de la entidad (Sprint 4.5): sus eventos con venta de entradas, si tienen PIN de portería y qué móviles
 * están dentro. Solo `DIRECTOR` o `COSIGNER` de esa entidad (el Super-Admin entra con registro). **Nunca selecciona el hash del PIN** (solo si existe y cuándo
 * caduca) ni el token de las sesiones; las sesiones no llevan datos de personas, solo el nombre que el voluntario dio a su móvil.
 */

export interface GateSessionView {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  scans: number;
}

export interface GateEventView {
  id: number;
  title: string;
  status: string;
  /** Fecha del evento (la fecha límite de la iniciativa). */
  eventDate: string;
  venue: string | null;
  ticketsSold: number;
  ticketMax: number | null;
  /** Código de la puerta para el enlace de la portería (se genera al crear el primer PIN); `null` si aún no hay PIN. */
  gateCode: string | null;
  pinActive: boolean;
  /** El PIN se anuló por demasiados intentos fallidos (y nadie ha creado otro): las sesiones abiertas siguen, pero nadie nuevo puede entrar. */
  pinRevoked: boolean;
  pinExpiresAt: string | null;
  sessions: GateSessionView[];
}

/** Más eventos de taquilla de los que una entidad tiene abiertos a la vez (el Estudio limita los borradores y las campañas abiertas). */
const EVENT_LIMIT = 30;
const SESSION_LIMIT = 20;
/** Un evento ya pasado se sigue viendo unos días (el recuento de última hora). */
const PAST_EVENT_DAYS = 7;

export async function loadGateAdmin(db: KorumPrismaClient, actor: SessionActor, organizationId: string, now: Date = new Date()): Promise<GateEventView[]> {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'gate.admin_view', targetType: 'Organization', targetId: organizationId });
  const rows = await db.initiative.findMany({
    where: { organizationId, format: 'TICKETING', status: { in: ['FUNDRAISING', 'GOAL_REACHED'] }, closesAt: { gt: new Date(now.getTime() - PAST_EVENT_DAYS * 86_400_000) } },
    orderBy: { closesAt: 'asc' },
    take: EVENT_LIMIT,
    select: {
      id: true,
      title: true,
      status: true,
      closesAt: true,
      ticketVenue: true,
      ticketsSold: true,
      ticketMax: true,
      gateCode: true,
      gatePinHash: true,
      gatePinExpiresAt: true,
      gateSessions: { where: { revokedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' }, take: SESSION_LIMIT, select: { id: true, deviceLabel: true, createdAt: true, _count: { select: { checkIns: true } } } }
    }
  });
  // Lo último que pasó con el PIN de cada evento: si fue una anulación por abuso, el panel lo dice (y avisa de que crear otro cierra las sesiones).
  const revoked = new Set<number>();
  for (const row of rows) {
    const last = await db.auditLog.findFirst({ where: { action: { in: ['gate.pin_set', 'gate.pin_revoked'] }, targetType: 'Initiative', targetId: String(row.id) }, orderBy: { id: 'desc' }, select: { action: true } });
    if (last?.action === 'gate.pin_revoked') revoked.add(row.id);
  }
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    eventDate: row.closesAt.toISOString(),
    venue: row.ticketVenue,
    ticketsSold: row.ticketsSold,
    ticketMax: row.ticketMax,
    gateCode: row.gateCode,
    pinActive: row.gatePinHash !== null && row.gatePinExpiresAt !== null && row.gatePinExpiresAt > now,
    pinRevoked: row.gatePinHash === null && revoked.has(row.id),
    pinExpiresAt: row.gatePinExpiresAt?.toISOString() ?? null,
    sessions: row.gateSessions.map((session) => ({ id: session.id, deviceLabel: session.deviceLabel, createdAt: session.createdAt.toISOString(), scans: session._count.checkIns }))
  }));
}
