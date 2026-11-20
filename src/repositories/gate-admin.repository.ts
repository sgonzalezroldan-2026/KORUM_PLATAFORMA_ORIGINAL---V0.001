import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import { madridIsoDate } from '@/core/studio/studio-draft';
import { eventChangeProblem, latestEventDate, latestRescheduleDay } from '@/core/ticketing/event-schedule-rules';
import { cancelledAfterSettlement, isSettledPayout, voucherDateBounds, voucherSaleChangeProblem } from '@/core/ticketing/voucher-lifecycle-rules';
import type { KorumPrismaClient } from '@/lib/prisma';
import { openRefundWindowUntil, voucherRefundState } from '@/services/ticketing/reschedule-window';
import { authorizeTenant, type SessionActor } from './tenant-guard';

/**
 * Datos de la pantalla «Taquilla y portería» de la entidad (Sprint 4.5): sus eventos con venta de entradas y, desde el Sprint 5.14c, sus ventas de vales (el
 * puesto de canje), si tienen PIN y qué móviles están dentro. Solo `DIRECTOR` o `COSIGNER` de esa entidad (el Super-Admin entra con registro). **Nunca selecciona el hash del PIN** (solo si existe y cuándo
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
  /** Evento con entradas o venta de vales (Sprint 5.14c): una venta de vales lleva su puesto, su validez y su propia cancelación. */
  kind: 'EVENT' | 'VOUCHER';
  voucher: VoucherSaleView | null;
}

export interface VoucherSaleView {
  /** Último instante en que se pueden gastar los vales y día de cierre de la venta. */
  validUntil: string;
  closesAt: string;
  targetCount: number | null;
  /** La entidad la canceló (decisiones 49, 69 y 71): sus vales ya no se gastan y responde ella ante quien compró. */
  cancelled: boolean;
  /** Sus vales ya caducaron. */
  expired: boolean;
  /** Ya se liquidó (el dinero está en la entidad). */
  settled: boolean;
  /** Se canceló cuando ya estaba liquidada: responde la entidad. Una cancelada antes y liquidada después (por lo gastado) no lo es: devolvió la plataforma. */
  cancelledAfterSettlement: boolean;
  /** Se puede cancelar o cambiar de fechas ahora. */
  canChange: boolean;
  /** El cierre solo se cambia mientras se vende. */
  canChangeClose: boolean;
  /** Aún se vende (la venta no ha cerrado). */
  selling: boolean;
  /** Días (`AAAA-MM-DD`, hora de España) actuales y límites que admite cada fecha. */
  closeDay: string;
  validDay: string;
  closeMinDay: string;
  closeMaxDay: string;
  validMinDay: string;
  validMaxDay: string;
  /** Hasta cuándo alguna compra puede pedir su devolución de 14 días: mientras tanto no se liquida. */
  refundOpenUntil: string | null;
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
  const recent = new Date(now.getTime() - PAST_EVENT_DAYS * DAY_MS);
  const rows = await db.initiative.findMany({
    // Los recientes y, aunque su fecha quede lejos, los celebrados que aún no se han liquidado: se pueden aplazar o cancelar hasta entonces.
    where: {
      organizationId,
      format: 'TICKETING',
      OR: [
        {
          OR: [{ ticketSubtype: null }, { ticketSubtype: 'EVENT' }],
          AND: [
            {
              OR: [
                { status: { in: ['FUNDRAISING', 'GOAL_REACHED'] }, OR: [{ closesAt: { gt: recent } }, { status: 'GOAL_REACHED', OR: [{ payout: null }, { payout: { status: 'PENDING_DOUBLE_CHECK' } }] }] },
                // Un evento cancelado hace poco sigue a la vista con su estado (no un borrador descartado, que nunca se publicó): quien lo canceló ve la confirmación.
                { status: { in: ['REFUNDING', 'REFUNDED', 'CANCELLED'] }, quotaReservedAt: { not: null }, updatedAt: { gt: recent } }
              ]
            }
          ]
        },
        // Una venta de vales mientras sus vales se pueden gastar (también cerrada o liquidada) y unos días después de caducar o de cancelarse.
        {
          ticketSubtype: 'VOUCHER',
          quotaReservedAt: { not: null },
          OR: [{ status: { in: ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED'] }, voucherValidUntil: { gt: recent } }, { status: 'CANCELLED', updatedAt: { gt: recent } }]
        }
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
      ticketSubtype: true,
      voucherValidUntil: true,
      voucherCancelledAt: true,
      voucherTargetCount: true,
      quotaReservedAt: true,
      createdAt: true,
      payout: { select: { status: true, approvedAt: true } },
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
  // En una venta de vales, la fecha real del último plazo (una cancelación por tratar no tiene fecha: se trata en minutos).
  for (const row of rows) refundOpen.set(row.id, row.ticketSubtype === 'VOUCHER' ? (await voucherRefundState(db, row.id, now)).until : await openRefundWindowUntil(db, row.id, now));
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
    kind: row.ticketSubtype === 'VOUCHER' ? ('VOUCHER' as const) : ('EVENT' as const),
    voucher: row.ticketSubtype === 'VOUCHER' && row.voucherValidUntil ? voucherView({ ...row, voucherValidUntil: row.voucherValidUntil }, refundOpen.get(row.id) ?? null, now, config.maxCampaignDays) : null,
    schedule: {
      canChange: eventChangeProblem({ format: row.format, ticketSubtype: row.ticketSubtype, status: row.status, payoutStatus: row.payout?.status ?? null }) === null,
      currentDay: madridIsoDate(row.closesAt),
      earliestDay: madridIsoDate(now),
      latestDay: latestRescheduleDay(latestEventDate(row.quotaReservedAt ?? row.createdAt, config.maxCampaignDays), now),
      refundOpenUntil: refundOpen.get(row.id)?.toISOString() ?? null,
      held: row.closesAt <= now
    }
  }));
}

function voucherView(
  row: { status: string; ticketSubtype: string | null; closesAt: Date; voucherValidUntil: Date; voucherCancelledAt: Date | null; voucherTargetCount: number | null; quotaReservedAt: Date | null; createdAt: Date; payout: { status: string; approvedAt: Date | null } | null },
  refundOpenUntil: Date | null,
  now: Date,
  maxCampaignDays: number
): VoucherSaleView {
  const bounds = voucherDateBounds({ publishedAt: row.quotaReservedAt ?? row.createdAt, closesAt: row.closesAt }, now, maxCampaignDays);
  const canChange = voucherSaleChangeProblem(row, now) === null;
  return {
    validUntil: row.voucherValidUntil.toISOString(),
    closesAt: row.closesAt.toISOString(),
    targetCount: row.voucherTargetCount,
    cancelled: row.voucherCancelledAt !== null,
    expired: row.voucherValidUntil <= now,
    settled: isSettledPayout(row.payout?.status ?? null),
    cancelledAfterSettlement: cancelledAfterSettlement(row.voucherCancelledAt, row.payout?.approvedAt ?? null),
    canChange,
    canChangeClose: canChange && row.status === 'FUNDRAISING',
    selling: row.status === 'FUNDRAISING' && row.voucherCancelledAt === null,
    closeDay: madridIsoDate(row.closesAt),
    validDay: madridIsoDate(row.voucherValidUntil),
    closeMinDay: madridIsoDate(now),
    closeMaxDay: bounds.closeMaxDay,
    validMinDay: bounds.validMinDay,
    validMaxDay: bounds.validMaxDay,
    refundOpenUntil: refundOpenUntil?.toISOString() ?? null
  };
}
