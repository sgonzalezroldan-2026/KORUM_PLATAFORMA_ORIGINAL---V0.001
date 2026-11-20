import { describe, expect, it } from 'vitest';
import { heldMaintenanceCents } from '@/core/ticketing/held-event';
import {
  planVoucherDates,
  statusAfterVoucherCancel,
  voucherDateBounds,
  voucherOutcomeAtClose,
  cancelledAfterSettlement,
  unspentRefundLines,
  unspentShareCents,
  voucherPinExpiry,
  voucherRefundDeadline,
  voucherRefundOffer,
  voucherReminderDue,
  voucherSaleChangeProblem,
  voucherSaleMaintenanceCents
} from '@/core/ticketing/voucher-lifecycle-rules';
import { voucherRedeemBlock } from '@/core/ticketing/voucher-rules';
import { endOfDayInMadrid } from '@/core/studio/studio-draft';
import { voucherBroadcastReadiness, voucherBroadcastVersion } from '@/services/notifications/voucher-broadcasts';

/**
 * Sprint 5.14c · reglas puras de una venta de vales ya publicada: el PIN del puesto, la devolución de 14 días (QA-VAL04), el cierre con el mantenimiento
 * proporcional (decisión 66), la cancelación (decisiones 49 y 69: antes de liquidar devuelve la plataforma lo no gastado) y el cambio de fechas (decisión 67 y las de
 * apertura del sprint: acortar la validez abre 14 días para recuperar lo no gastado).
 */

const DAY = 86_400_000;
const NOW = new Date('2026-11-20T10:00:00Z');
const day = (iso: string) => endOfDayInMadrid(iso)!;

describe('PIN del puesto', () => {
  it('vale hasta el final de la validez de los vales', () => {
    const validUntil = day('2027-09-01');
    expect(voucherPinExpiry(validUntil, NOW)).toEqual(validUntil);
  });

  it('nunca más de un año, por lejana que sea la validez', () => {
    expect(voucherPinExpiry(day('2028-03-01'), NOW).getTime()).toBe(NOW.getTime() + 365 * DAY);
  });
});

describe('mantenimiento de una venta de vales que se liquida (decisión 66)', () => {
  it('con tope: en proporción a los vales vendidos sobre el tope, hacia abajo', () => {
    expect(voucherSaleMaintenanceCents(1_000, { ticketsSold: 1, ticketMax: 3, voucherTargetCount: null })).toBe(333);
    expect(voucherSaleMaintenanceCents(1_000, { ticketsSold: 150, ticketMax: 300, voucherTargetCount: null })).toBe(500);
  });

  it('sin tope: sobre el objetivo orientativo, y entero al llegar o pasarlo', () => {
    expect(voucherSaleMaintenanceCents(1_000, { ticketsSold: 75, ticketMax: null, voucherTargetCount: 300 })).toBe(250);
    expect(voucherSaleMaintenanceCents(1_000, { ticketsSold: 300, ticketMax: null, voucherTargetCount: 300 })).toBe(1_000);
    expect(voucherSaleMaintenanceCents(1_000, { ticketsSold: 450, ticketMax: null, voucherTargetCount: 300 })).toBe(1_000);
  });

  it('sin vales vendidos (todos devueltos) o sin mantenimiento, nada', () => {
    expect(voucherSaleMaintenanceCents(1_000, { ticketsSold: 0, ticketMax: 300, voucherTargetCount: null })).toBe(0);
    expect(voucherSaleMaintenanceCents(0, { ticketsSold: 10, ticketMax: 300, voucherTargetCount: null })).toBe(0);
  });

  it('heldMaintenanceCents mide los vales en una venta de vales y el dinero en un evento', () => {
    const base = { format: 'TICKETING', raisedCents: 6_000, goalCents: 60_000, ticketsSold: 30, ticketMax: 300, voucherTargetCount: null, maintFeeCents: 1_000, quotaReservedMaintCents: 1_000 };
    expect(heldMaintenanceCents({ ...base, ticketSubtype: 'VOUCHER' })).toBe(100);
    expect(heldMaintenanceCents({ ...base, ticketSubtype: 'EVENT' })).toBe(100);
    // Un evento mide el dinero: con «sin producto» o gastos incluidos la proporción puede no coincidir con la de vales.
    expect(heldMaintenanceCents({ ...base, ticketSubtype: 'VOUCHER', raisedCents: 30_000 })).toBe(100);
    expect(heldMaintenanceCents({ ...base, ticketSubtype: 'EVENT', raisedCents: 30_000 })).toBe(500);
  });
});

describe('cierre de la venta', () => {
  it('con vales o con aportaciones «sin producto» se liquida; sin nada, se cierra sin dinero', () => {
    expect(voucherOutcomeAtClose(2_000, 10)).toBe('SETTLE');
    expect(voucherOutcomeAtClose(600, 0)).toBe('SETTLE');
    expect(voucherOutcomeAtClose(0, 0)).toBe('CLOSE_EMPTY');
  });
});

describe('devolución de 14 días (QA-VAL04) y la de lo no gastado al acortarse la validez (decisión 69)', () => {
  const purchase = { contributionStatus: 'COMPLETED', revokedAt: null, quantity: 10, checkedInCount: 0, issuedAt: new Date(NOW.getTime() - 3 * DAY), payoutStatus: null, shortenedAt: null };

  it('el día 3, sin gastar nada, el 100 % hasta 14 días después de recibir los vales', () => {
    expect(voucherRefundOffer(purchase, NOW)).toEqual({ kind: 'FULL', until: voucherRefundDeadline(purchase.issuedAt) });
    expect(voucherRefundDeadline(purchase.issuedAt).getTime()).toBe(purchase.issuedAt.getTime() + 14 * DAY);
  });

  it('con un vale gastado ya no; el día 15 ya no; justo al cumplirse los 14 días, tampoco', () => {
    expect(voucherRefundOffer({ ...purchase, checkedInCount: 1 }, NOW)).toEqual({ block: 'SPENT' });
    expect(voucherRefundOffer({ ...purchase, issuedAt: new Date(NOW.getTime() - 15 * DAY) }, NOW)).toEqual({ block: 'WINDOW_CLOSED' });
    expect(voucherRefundOffer({ ...purchase, issuedAt: new Date(NOW.getTime() - 14 * DAY) }, NOW)).toEqual({ block: 'WINDOW_CLOSED' });
    expect(voucherRefundOffer({ ...purchase, checkedInCount: 10 }, NOW)).toEqual({ block: 'SPENT' });
  });

  it('acortada la validez: quien compró antes recupera lo no gastado durante 14 días desde el cambio, aunque haya gastado parte o hayan pasado sus 14 días', () => {
    const shortenedAt = new Date(NOW.getTime() - 2 * DAY);
    const old = { ...purchase, issuedAt: new Date(NOW.getTime() - 30 * DAY), checkedInCount: 3, shortenedAt };
    expect(voucherRefundOffer(old, NOW)).toEqual({ kind: 'UNSPENT', until: voucherRefundDeadline(shortenedAt) });
    expect(voucherRefundOffer({ ...old, checkedInCount: 0 }, NOW)).toEqual({ kind: 'FULL', until: voucherRefundDeadline(shortenedAt) });
    // Quien compró después del cambio ya conocía la fecha nueva: solo tiene sus propios 14 días.
    expect(voucherRefundOffer({ ...old, issuedAt: new Date(NOW.getTime() - DAY) }, NOW)).toEqual({ block: 'SPENT' });
    expect(voucherRefundOffer(old, new Date(shortenedAt.getTime() + 15 * DAY))).toEqual({ block: 'WINDOW_CLOSED' });
  });

  it('una compra ya devuelta, anulada o sin cobrar no se devuelve otra vez', () => {
    expect(voucherRefundOffer({ ...purchase, contributionStatus: 'REFUND_PENDING' }, NOW)).toEqual({ block: 'ALREADY_REFUNDED' });
    expect(voucherRefundOffer({ ...purchase, contributionStatus: 'REFUNDED' }, NOW)).toEqual({ block: 'ALREADY_REFUNDED' });
    expect(voucherRefundOffer({ ...purchase, revokedAt: NOW }, NOW)).toEqual({ block: 'NOT_PAID' });
    expect(voucherRefundOffer({ ...purchase, contributionStatus: 'CHARGEBACK' }, NOW)).toEqual({ block: 'NOT_PAID' });
  });

  it('con la venta ya liquidada el dinero no está: no se devuelve (la liquidación espera a los plazos, así que no debería ocurrir)', () => {
    expect(voucherRefundOffer({ ...purchase, payoutStatus: 'APPROVED' }, NOW)).toEqual({ block: 'SETTLED' });
    expect(voucherRefundOffer({ ...purchase, payoutStatus: 'PENDING_DOUBLE_CHECK' }, NOW)).toMatchObject({ kind: 'FULL' });
  });

  it('lo no gastado: la parte de cada línea del cobro que corresponde a los vales sin gastar, al céntimo más cercano', () => {
    // 10 vales de 2 € con 65 cts de gestión: quedan 7 sin gastar.
    expect(unspentShareCents(2_000, 7, 10)).toBe(1_400);
    expect(unspentShareCents(65, 7, 10)).toBe(46);
    expect(unspentShareCents(65, 10, 10)).toBe(65);
    expect(unspentShareCents(65, 0, 10)).toBe(0);
    expect(unspentShareCents(1, 1, 3)).toBe(0);
  });

  it('lo que enseña el pase y lo que se aprueba salen de las mismas líneas del cobro, redondeadas una a una', () => {
    const lines = [
      { direction: 'DEBIT' as const, amountCents: 300 },
      { direction: 'CREDIT' as const, amountCents: 200 },
      { direction: 'CREDIT' as const, amountCents: 50 },
      { direction: 'CREDIT' as const, amountCents: 50 }
    ];
    // 4 vales con 3 gastados: 50 + 13 + 13 (no 50 + 25).
    expect(unspentRefundLines(lines, 1, 4).map((line) => line.amountCents)).toEqual([50, 13, 13]);
    expect(unspentRefundLines(lines, 1, 4).every((line) => line.direction === 'DEBIT')).toBe(true);
  });
});

describe('cancelar (decisiones 49 y 69)', () => {
  const sale = { ticketSubtype: 'VOUCHER', status: 'FUNDRAISING', voucherCancelledAt: null, voucherValidUntil: day('2027-09-01') };

  it('se cancela a la venta, cerrada sin liquidar o ya liquidada, mientras los vales valgan', () => {
    for (const status of ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED']) expect(voucherSaleChangeProblem({ ...sale, status }, NOW)).toBeNull();
  });

  it('no se cancela dos veces, ni una venta cerrada sin ventas, ni con los vales caducados, ni un evento', () => {
    expect(voucherSaleChangeProblem({ ...sale, voucherCancelledAt: NOW }, NOW)).toBe('ALREADY_CANCELLED');
    expect(voucherSaleChangeProblem({ ...sale, status: 'CANCELLED' }, NOW)).toBe('WRONG_STATUS');
    expect(voucherSaleChangeProblem({ ...sale, voucherValidUntil: new Date(NOW.getTime() - 1) }, NOW)).toBe('EXPIRED');
    expect(voucherSaleChangeProblem({ ...sale, ticketSubtype: 'EVENT' }, NOW)).toBe('NOT_A_VOUCHER_SALE');
  });

  it('una venta abierta con algo vendido se cierra ya y se liquida por lo vendido; sin nada, se cierra sin dinero; una cerrada no cambia de estado', () => {
    expect(statusAfterVoucherCancel({ status: 'FUNDRAISING', raisedCents: 2_000, ticketsSold: 10 })).toBe('GOAL_REACHED');
    expect(statusAfterVoucherCancel({ status: 'FUNDRAISING', raisedCents: 0, ticketsSold: 0 })).toBe('CANCELLED');
    expect(statusAfterVoucherCancel({ status: 'GOAL_REACHED', raisedCents: 2_000, ticketsSold: 10 })).toBeNull();
    expect(statusAfterVoucherCancel({ status: 'CLOSED', raisedCents: 2_000, ticketsSold: 10 })).toBeNull();
  });

  it('cancelada después de liquidar responde la entidad; cancelada antes y liquidada después por lo gastado, devolvió la plataforma', () => {
    expect(cancelledAfterSettlement(NOW, new Date(NOW.getTime() - DAY))).toBe(true);
    expect(cancelledAfterSettlement(NOW, new Date(NOW.getTime() + DAY))).toBe(false);
    expect(cancelledAfterSettlement(NOW, null)).toBe(false);
    expect(cancelledAfterSettlement(null, NOW)).toBe(false);
  });

  it('el puesto no canjea una venta cancelada, aunque siga pendiente de liquidar o ya liquidada', () => {
    const pass = { revokedAt: null, contributionStatus: 'COMPLETED' };
    expect(voucherRedeemBlock(pass, { status: 'GOAL_REACHED', voucherValidUntil: day('2027-09-01'), voucherCancelledAt: NOW }, NOW)).toBe('SALE_CANCELLED');
    expect(voucherRedeemBlock(pass, { status: 'CLOSED', voucherValidUntil: day('2027-09-01'), voucherCancelledAt: null }, NOW)).toBeNull();
  });
});

describe('cambiar las fechas', () => {
  const publishedAt = new Date('2026-11-01T10:00:00Z');
  const sale = { status: 'FUNDRAISING', closesAt: day('2026-12-15'), voucherValidUntil: day('2027-09-01'), publishedAt, settled: false, maxCampaignDays: 60 };

  it('alargar o acortar la validez dice cuál de las dos es', () => {
    const longer = planVoucherDates({ validDay: '2027-10-01' }, sale, NOW);
    const shorter = planVoucherDates({ validDay: '2027-06-30' }, sale, NOW);
    expect('problem' in longer ? longer.problem : longer.validity).toBe('EXTENDED');
    expect('problem' in shorter ? shorter.problem : shorter.validity).toBe('SHORTENED');
  });

  it('mover el cierre no cambia la validez', () => {
    const plan = planVoucherDates({ closeDay: '2026-12-20' }, sale, NOW);
    expect(plan).toMatchObject({ closeChanged: true, validity: null, closesAt: day('2026-12-20') });
  });

  it('el cierre: por venir, solo con la venta abierta y como mucho 60 días desde la publicación', () => {
    expect(planVoucherDates({ closeDay: '2026-11-19' }, sale, NOW)).toEqual({ problem: 'CLOSE_IN_PAST' });
    expect(planVoucherDates({ closeDay: '2027-01-15' }, sale, NOW)).toEqual({ problem: 'CLOSE_TOO_LATE' });
    expect(planVoucherDates({ closeDay: '2026-12-20' }, { ...sale, status: 'GOAL_REACHED' }, NOW)).toEqual({ problem: 'CLOSE_NOT_CHANGEABLE' });
    expect(planVoucherDates({ closeDay: '2026-02-30' }, sale, NOW)).toEqual({ problem: 'CLOSE_INVALID' });
  });

  it('la validez: desde el cierre (y hoy) hasta 12 meses después del cierre', () => {
    expect(planVoucherDates({ validDay: '2026-12-14' }, sale, NOW)).toEqual({ problem: 'VALIDITY_BEFORE_CLOSE' });
    expect(planVoucherDates({ validDay: '2027-12-16' }, sale, NOW)).toEqual({ problem: 'VALIDITY_TOO_LATE' });
    expect(planVoucherDates({ closeDay: '2026-12-20', validDay: '2026-12-18' }, sale, NOW)).toEqual({ problem: 'VALIDITY_BEFORE_CLOSE' });
    const closed = { ...sale, status: 'GOAL_REACHED', closesAt: day('2026-11-10') };
    expect(planVoucherDates({ validDay: '2026-11-15' }, closed, NOW)).toEqual({ problem: 'VALIDITY_IN_PAST' });
  });

  it('acortar la validez abre 14 días de devolución: no cabe si acabarían después de la venta más sus 14 días (día 74 con 60 días; nunca más del 75)', () => {
    const late = { ...sale, status: 'GOAL_REACHED', closesAt: day('2026-11-19'), publishedAt: new Date(NOW.getTime() - 62 * DAY) };
    expect(planVoucherDates({ validDay: '2027-06-30' }, late, NOW)).toEqual({ problem: 'SHORTEN_TOO_LATE' });
    // Alargarla sí cabe: no abre ningún plazo.
    expect(planVoucherDates({ validDay: '2027-10-01' }, late, NOW)).toMatchObject({ validity: 'EXTENDED' });
    expect(planVoucherDates({ validDay: '2027-06-30' }, { ...late, publishedAt: new Date(NOW.getTime() - 61 * DAY) }, NOW)).toEqual({ problem: 'SHORTEN_TOO_LATE' });
    expect(planVoucherDates({ validDay: '2027-06-30' }, { ...late, publishedAt: new Date(NOW.getTime() - 60 * DAY) }, NOW)).toMatchObject({ validity: 'SHORTENED' });
  });

  it('ya liquidada, la validez solo se alarga', () => {
    const settled = { ...sale, status: 'CLOSED', settled: true };
    expect(planVoucherDates({ validDay: '2027-06-30' }, settled, NOW)).toEqual({ problem: 'VALIDITY_SHORTER_AFTER_PAYOUT' });
    expect(planVoucherDates({ validDay: '2027-10-01' }, settled, NOW)).toMatchObject({ validity: 'EXTENDED' });
  });

  it('los límites siguen la duración máxima de la consola: con 30 días, el cierre no pasa de 30 y acortar no cabe pasado el día 44', () => {
    expect(planVoucherDates({ closeDay: '2026-12-20' }, { ...sale, maxCampaignDays: 30 }, NOW)).toEqual({ problem: 'CLOSE_TOO_LATE' });
    expect(voucherDateBounds({ publishedAt, closesAt: sale.closesAt }, NOW, 30).closeMaxDay).toBe('2026-11-30');
    const closed = { ...sale, status: 'GOAL_REACHED', closesAt: day('2026-11-19'), maxCampaignDays: 30 };
    expect(planVoucherDates({ validDay: '2027-06-30' }, { ...closed, publishedAt: new Date(NOW.getTime() - 31 * DAY) }, NOW)).toEqual({ problem: 'SHORTEN_TOO_LATE' });
    expect(planVoucherDates({ validDay: '2027-06-30' }, { ...closed, publishedAt: new Date(NOW.getTime() - 30 * DAY) }, NOW)).toMatchObject({ validity: 'SHORTENED' });
  });

  it('sin cambiar nada, lo dice', () => {
    expect(planVoucherDates({ closeDay: '2026-12-15', validDay: '2027-09-01' }, sale, NOW)).toEqual({ problem: 'NO_CHANGE' });
  });

  it('los límites que enseña el panel: el último día de venta es el mismo que admite el Estudio (60 días desde la publicación, contados al minuto)', () => {
    expect(voucherDateBounds({ publishedAt, closesAt: sale.closesAt }, NOW, 60)).toEqual({ closeMaxDay: '2026-12-30', validMinDay: '2026-12-15', validMaxDay: '2027-12-15' });
  });
});

describe('recordatorio y avisos a quien tiene vales', () => {
  const validUntil = day('2027-09-01');
  const sale = { ticketSubtype: 'VOUCHER', voucherValidUntil: validUntil, voucherCancelledAt: null };

  it('el recordatorio sale una semana antes, mientras aún valen', () => {
    expect(voucherReminderDue(validUntil, new Date(validUntil.getTime() - 8 * DAY))).toBe(false);
    expect(voucherReminderDue(validUntil, new Date(validUntil.getTime() - 7 * DAY))).toBe(true);
    expect(voucherReminderDue(validUntil, new Date(validUntil.getTime() + 1))).toBe(false);
    expect(voucherBroadcastReadiness('voucher.expiryReminder', sale, new Date(validUntil.getTime() - 10 * DAY))).toBe('WAIT');
    expect(voucherBroadcastReadiness('voucher.expiryReminder', sale, new Date(validUntil.getTime() - 3 * DAY))).toBe('SEND');
  });

  it('una venta cancelada solo avisa de la cancelación; con los vales caducados, nada', () => {
    const cancelled = { ...sale, voucherCancelledAt: NOW };
    expect(voucherBroadcastReadiness('voucher.cancelledBuyer', cancelled, NOW)).toBe('SEND');
    expect(voucherBroadcastReadiness('voucher.expiryReminder', cancelled, NOW)).toBe('DROP');
    expect(voucherBroadcastReadiness('voucher.validityChanged', cancelled, NOW)).toBe('DROP');
    expect(voucherBroadcastReadiness('voucher.cancelledBuyer', sale, NOW)).toBe('DROP');
    expect(voucherBroadcastReadiness('voucher.validityChanged', sale, new Date(validUntil.getTime() + 1))).toBe('DROP');
  });

  it('el aviso de validez y el recordatorio llevan la fecha en su clave: un segundo cambio vuelve a avisar', () => {
    const later = { ...sale, voucherValidUntil: day('2027-10-01') };
    expect(voucherBroadcastVersion('voucher.validityChanged', sale)).not.toBe(voucherBroadcastVersion('voucher.validityChanged', later));
    expect(voucherBroadcastVersion('voucher.cancelledBuyer', sale)).toBe('');
  });
});
