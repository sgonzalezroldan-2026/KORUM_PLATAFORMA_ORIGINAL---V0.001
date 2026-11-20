import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { madridIsoDate } from '@/core/studio/studio-draft';
import { eventChangeProblem, latestEventDate, latestRescheduleDay } from '@/core/ticketing/event-schedule-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { openRescheduleRefundUntil } from '@/services/ticketing/reschedule-window';
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
  /** Cancelar y cambiar la fecha (Sprint 5.13): se puede mientras no se haya liquidado. */
  schedule: EventScheduleView;
}

export interface EventScheduleView {
  /** El evento sigue vivo y sin liquidar: se puede cancelar y, si cabe, cambiar de fecha. */
  canChange: boolean;
  /** Día actual del evento (`AAAA-MM-DD`, hora de España) y el primero y el último que se pueden elegir; `latestDay` es `null` si ya no cabe ningún cambio. */
  currentDay: string;
  earliestDay: string;
  latestDay: string | null;
  /** Hasta cuándo pueden pedir su devolución quienes compraron antes del último cambio de fecha; mientras tanto no se liquida. */
  refundOpenUntil: string | null;
  /** La fecha ya pasó y el evento espera su liquidación por lo vendido. */
  held: boolean;
}

/** Más eventos de taquilla de los que una entidad tiene abiertos a la vez (el Estudio limita los borradores y las campañas abiertas). */
const EVENT_LIMIT = 30;
const SESSION_LIMIT = 20;
/** Un evento ya pasado se sigue viendo unos días (el recuento de última hora). */
const PAST_EVENT_DAYS = 7;
const DAY_MS = 86_400_000;

export async function loadGateAdmin(db: KorumPrismaClient, actor: SessionActor, organizationId: string, now: Date = new Date()): Promise<GateEventView[]> {
  await authorizeTenant(db, actor, organizationId, { roles: SIGNER_ROLES, action: 'gate.admin_view', targetType: 'Organization', targetId: organizationId });
  const rows = await db.initiative.findMany({
    // Los recientes y, aunque su fecha quede lejos, los celebrados que aún no se han liquidado: se pueden aplazar o cancelar hasta entonces.
    where: {
      organizationId,
      format: 'TICKETING',
      // Solo eventos: el puesto de canje de una venta de vales es otra pantalla (Sprint 5.14c).
      AND: [{ OR: [{ ticketSubtype: null }, { ticketSubtype: 'EVENT' }] }],
      OR: [
        { status: { in: ['FUNDRAISING', 'GOAL_REACHED'] }, OR: [{ closesAt: { gt: new Date(now.getTime() - PAST_EVENT_DAYS * DAY_MS) } }, { status: 'GOAL_REACHED', OR: [{ payout: null }, { payout: { status: 'PENDING_DOUBLE_CHECK' } }] }] },
        // Un evento cancelado hace poco sigue a la vista con su estado (no un borrador descartado, que nunca se publicó): quien lo canceló ve la confirmación.
        { status: { in: ['REFUNDING', 'REFUNDED', 'CANCELLED'] }, quotaReservedAt: { not: null }, updatedAt: { gt: new Date(now.getTime() - PAST_EVENT_DAYS * DAY_MS) } }
      ]
    },
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
      format: true,
      quotaReservedAt: true,
      createdAt: true,
      payout: { select: { status: true } },
      gateSessions: { where: { revokedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' }, take: SESSION_LIMIT, select: { id: true, deviceLabel: true, createdAt: true, _count: { select: { checkIns: true } } } }
    }
  });
  const config = await db.globalConfig.findUniqueOrThrow({ where: { id: 'GLOBAL' }, select: { maxCampaignDays: true } });
  // Lo último que pasó con el PIN de cada evento: si fue una anulación por abuso, el panel lo dice (y avisa de que crear otro cierra las sesiones).
  const revoked = new Set<number>();
  for (const row of rows) {
    const last = await db.auditLog.findFirst({ where: { action: { in: ['gate.pin_set', 'gate.pin_revoked'] }, targetType: 'Initiative', targetId: String(row.id) }, orderBy: { id: 'desc' }, select: { action: true } });
    if (last?.action === 'gate.pin_revoked') revoked.add(row.id);
  }
  // El plazo que de verdad bloquea la liquidación: el de un cambio con alguien a quien devolver (la misma regla que la liquidación).
  const refundOpen = new Map<number, Date | null>();
  for (const row of rows) refundOpen.set(row.id, await openRescheduleRefundUntil(db, row.id, now));
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
    sessions: row.gateSessions.map((session) => ({ id: session.id, deviceLabel: session.deviceLabel, createdAt: session.createdAt.toISOString(), scans: session._count.checkIns })),
    schedule: {
      canChange: eventChangeProblem({ format: row.format, status: row.status, payoutStatus: row.payout?.status ?? null }) === null,
      currentDay: madridIsoDate(row.closesAt),
      earliestDay: madridIsoDate(now),
      latestDay: latestRescheduleDay(latestEventDate(row.quotaReservedAt ?? row.createdAt, config.maxCampaignDays), now),
      refundOpenUntil: refundOpen.get(row.id)?.toISOString() ?? null,
      held: row.closesAt <= now
    }
  }));
}
