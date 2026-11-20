import { voucherRefundDeadline, voucherReminderDue } from '@/core/ticketing/voucher-lifecycle-rules';
import type { Db } from '@/lib/db';

/**
 * Avisos por lotes a quien tiene **vales sin gastar** de una venta (y, en la cancelación ya liquidada, a quien aportó «sin producto», condiciones §4.6) (Sprint 5.14c). Los reparte la tarea `SUPPORTER_BROADCAST` con el mismo mecanismo que los
 * demás avisos a quienes aportaron (`supporter-broadcast.ts`): una fila por venta y aviso, un cursor y un mensaje por persona aunque comprara varias veces.
 *
 * - `voucher.cancelledBuyer`, **con la venta ya liquidada**: la entidad la canceló y el dinero ya está en ella (decisiones 49 y 69). Sus vales ya no se gastan:
 *   a quien tiene vales sin gastar y a quien aportó «sin producto», se le dice que se lo pida a la entidad, con el enlace a su página de ayuda (el email de quien dirige no se enseña: es de esa persona). Una por persona. Si se
 *   cancela antes de liquidar, el aviso sale con cada devolución (`voucher-cancel-refunds.ts`).
 * - `voucher.validityChanged`: la entidad alargó o acortó la validez. Si la acortó, el aviso dice hasta cuándo se puede recuperar lo no gastado (decisión 69).
 * - `voucher.expiryReminder`: faltan 7 días o menos para que caduquen (decisión 32). Lo deja pendiente la propia tarea cada día (`queueDueVoucherReminders`).
 *
 * El cambio de validez y el recordatorio van **por compra**, con el enlace a sus vales (cada compra tiene el suyo), y dependen de la fecha: la clave lleva la
 * fecha, así que un segundo cambio vuelve a avisar con la fecha nueva y un recordatorio ya enviado no se repite para la misma fecha. Solo a compras pagadas y sin
 * devolver, con su pase sin anular y algún vale por gastar; nunca a una aportación «sin producto», que no tiene vales.
 */

export const VOUCHER_BROADCAST_TEMPLATES = ['voucher.cancelledBuyer', 'voucher.validityChanged', 'voucher.expiryReminder'] as const;
export type VoucherBroadcastTemplate = (typeof VOUCHER_BROADCAST_TEMPLATES)[number];

export const isVoucherBroadcast = (key: string): key is VoucherBroadcastTemplate => (VOUCHER_BROADCAST_TEMPLATES as readonly string[]).includes(key);

export interface VoucherSaleForBroadcast {
  ticketSubtype: string | null;
  voucherValidUntil: Date | null;
  voucherCancelledAt: Date | null;
  voucherValidityShortenedAt?: Date | null;
}

/** ¿Se reparte ya? `WAIT`: aún no toca (el recordatorio de una validez que se alargó); `DROP`: ya no tiene sentido. */
export function voucherBroadcastReadiness(templateKey: VoucherBroadcastTemplate, sale: VoucherSaleForBroadcast, now: Date): 'SEND' | 'WAIT' | 'DROP' {
  if (sale.ticketSubtype !== 'VOUCHER' || sale.voucherValidUntil === null) return 'DROP';
  if (templateKey === 'voucher.cancelledBuyer') return sale.voucherCancelledAt !== null ? 'SEND' : 'DROP';
  // Una venta cancelada o con los vales ya caducados no recuerda ni avisa de fechas: sus vales no se pueden gastar.
  if (sale.voucherCancelledAt !== null || sale.voucherValidUntil.getTime() <= now.getTime()) return 'DROP';
  if (templateKey === 'voucher.validityChanged') return 'SEND';
  return voucherReminderDue(sale.voucherValidUntil, now) ? 'SEND' : 'WAIT';
}

/** Parte de la clave de cada mensaje que depende de la fecha: con otra validez, el aviso o el recordatorio es otro. */
export const voucherBroadcastVersion = (templateKey: VoucherBroadcastTemplate, sale: VoucherSaleForBroadcast): string =>
  templateKey === 'voucher.cancelledBuyer' ? '' : `:${sale.voucherValidUntil?.getTime() ?? 0}`;

/** ¿Va un mensaje por compra (con el enlace a sus vales) o uno por persona? */
export const isPerPurchase = (templateKey: VoucherBroadcastTemplate): boolean => templateKey !== 'voucher.cancelledBuyer';

/**
 * Lo que lleva el mensaje además de la venta: la validez con la que se escribió; en los avisos por compra, el pase (el enlace a sus vales se firma al enviar);
 * si se acortó la validez y el plazo sigue abierto, hasta cuándo se puede recuperar lo no gastado; y en la cancelación, que ya estaba liquidada.
 */
export function voucherBroadcastPayload(templateKey: VoucherBroadcastTemplate, sale: VoucherSaleForBroadcast, pass: { uuid: string; issuedAt: Date } | null, now: Date): Record<string, string | boolean> {
  if (templateKey === 'voucher.cancelledBuyer') return { settled: true };
  const payload: Record<string, string | boolean> = {};
  if (sale.voucherValidUntil) payload.validUntil = sale.voucherValidUntil.toISOString();
  if (pass) payload.passUuid = pass.uuid;
  // Solo a quien compró antes del acortamiento: quien compró después ya conocía la fecha y no tiene ese plazo (`voucherRefundOffer`).
  const shortenedAt = sale.voucherValidityShortenedAt ?? null;
  const refundUntil = shortenedAt && pass && pass.issuedAt.getTime() < shortenedAt.getTime() ? voucherRefundDeadline(shortenedAt) : null;
  if (templateKey === 'voucher.validityChanged' && refundUntil && refundUntil > now) payload.refundUntil = refundUntil.toISOString();
  return payload;
}

/**
 * Filtro de base de datos de las compras a las que llega: pagadas, con vales y su pase sin anular y con algún vale por gastar. La cancelación ya liquidada llega
 * además a quien aportó «sin producto» (condiciones §4.6: «se aplica lo mismo que a los vales»).
 */
export function voucherRecipientWhere(templateKey: VoucherBroadcastTemplate, db: Pick<Db, 'ticketPass'>) {
  const withVouchers = { voucherNoProduct: false, ticketPass: { is: { revokedAt: null, subtype: 'VOUCHER' as const, checkedInCount: { lt: db.ticketPass.fields.quantity } } } };
  return templateKey === 'voucher.cancelledBuyer' ? { OR: [{ voucherNoProduct: true }, withVouchers] } : withVouchers;
}

export const hasUnspentVouchers = (row: { voucherNoProduct?: boolean; ticketPass?: { quantity: number; checkedInCount: number } | null }): boolean =>
  row.voucherNoProduct === true || (row.ticketPass !== null && row.ticketPass !== undefined && row.ticketPass.checkedInCount < row.ticketPass.quantity);

/**
 * Vuelve a repartir el aviso de cambio de validez desde el principio, con la fecha nueva, y deja esperando el recordatorio (que saldrá una semana antes de la
 * fecha nueva). Si el recordatorio ya salió con la fecha anterior, se repetirá con la nueva: la clave lleva la fecha.
 */
export async function restartVoucherBroadcast(tx: Db, initiativeId: number, now: Date): Promise<void> {
  await tx.supporterBroadcast.upsert({
    where: { initiativeId_templateKey: { initiativeId, templateKey: 'voucher.validityChanged' } },
    create: { initiativeId, templateKey: 'voucher.validityChanged', createdAt: now },
    update: { cursorId: 0, completedAt: null }
  });
  await tx.supporterBroadcast.updateMany({ where: { initiativeId, templateKey: 'voucher.expiryReminder' }, data: { cursorId: 0, completedAt: null } });
}

/**
 * Deja pendiente el recordatorio de las ventas cuyos vales caducan en los próximos 7 días (una fila por venta; repetirlo no hace nada). Lo llama la tarea
 * `SUPPORTER_BROADCAST` antes de repartir. Solo ventas con vales vendidos, sin cancelar y aún vigentes.
 */
export async function queueDueVoucherReminders(db: Db, now: Date, limit: number): Promise<number> {
  const horizon = new Date(now.getTime() + 7 * 86_400_000);
  const due = await db.initiative.findMany({
    where: {
      ticketSubtype: 'VOUCHER',
      voucherCancelledAt: null,
      ticketsSold: { gt: 0 },
      status: { in: ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED'] },
      voucherValidUntil: { gt: now, lte: horizon },
      supporterBroadcasts: { none: { templateKey: 'voucher.expiryReminder' } }
    },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true }
  });
  if (due.length === 0) return 0;
  const { count } = await db.supporterBroadcast.createMany({ data: due.map(({ id }) => ({ initiativeId: id, templateKey: 'voucher.expiryReminder', createdAt: now })), skipDuplicates: true });
  return count;
}
