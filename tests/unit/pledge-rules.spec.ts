import { describe, expect, it } from 'vitest';
import { donationOrTicketPayinLines } from '@/core/finance/payment-journals';
import { chargeDayOf, pledgeCommitmentCents, pledgeFeeCents, PLEDGE_MAX_CENTS, PLEDGE_MIN_CENTS } from '@/core/pledges/pledge-limits';
import { newPledgeOrder, nextChargeAt, pickPledgeCampaign, pledgeInputSchema } from '@/core/pledges/pledge-rules';
import { isCheckoutOrder } from '@/core/checkout/checkout-rules';
import { MockPaycometProvider } from '@/services/payments/mock-paycomet';

/**
 * QA-F08 (modo `PLEDGE`) · reglas puras de la aportación mensual de Mi Hucha: cuánto se cobra encima (la campaña recibe el 100 %), qué día,
 * a qué campaña va cada mes, qué acepta el servidor y que el token de la tarjeta nunca llega a lo que se guarda de la notificación.
 */

const utc = (text: string) => new Date(`${text}Z`);

describe('Gestión de Mi Hucha por cargo', () => {
  it('es la de la consola (0,25 € + 0 % por defecto) y se suma encima: la campaña recibe el importe íntegro', () => {
    expect(pledgeFeeCents(1_000, { topupFeeCents: 25, topupFeeBps: 0 })).toBe(25);
    expect(pledgeFeeCents(5_000, { topupFeeCents: 10, topupFeeBps: 100 })).toBe(60);
    expect(pledgeCommitmentCents(1_000, 25, 9)).toBe(9_225);
  });

  it('nunca da un importe negativo ni decimal', () => {
    expect(() => pledgeFeeCents(1_000, { topupFeeCents: -30, topupFeeBps: 0 })).toThrow(RangeError);
    expect(Number.isSafeInteger(pledgeFeeCents(333, { topupFeeCents: 0, topupFeeBps: 333 }))).toBe(true);
  });

  it('en el asiento, la gestión va a su cuenta de ingresos y la donación entera a la hucha de la campaña', () => {
    const lines = donationOrTicketPayinLines({ organizationId: 'org', initiativeId: 1 }, { type: 'DONATION', amountCents: 1_000, guaranteeCents: 0, serviceFeeCents: 25, totalChargedCents: 1_025 });
    expect(lines).toEqual([
      expect.objectContaining({ account: 'PSP_CLEARING', direction: 'DEBIT', amountCents: 1_025 }),
      expect.objectContaining({ account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 1_000 }),
      expect.objectContaining({ account: 'KORUM_REVENUE_TOPUP_FEE', direction: 'CREDIT', amountCents: 25 })
    ]);
    // Una entrada sigue llevando sus gastos de gestión digital a su propia cuenta.
    const ticket = donationOrTicketPayinLines({ organizationId: 'org', initiativeId: 1 }, { type: 'TICKET', amountCents: 500, guaranteeCents: 0, serviceFeeCents: 55, totalChargedCents: 555 });
    expect(ticket.at(-1)).toMatchObject({ account: 'KORUM_REVENUE_TICKET_FEE', amountCents: 55 });
  });
});

describe('Calendario de cobros', () => {
  it('el día de cobro es el del primer pago en hora de España, sin pasar del 28', () => {
    expect(chargeDayOf(utc('2026-11-07T10:00:00'))).toBe(7);
    // 30 de noviembre a las 23:30 UTC ya es 1 de diciembre en Madrid.
    expect(chargeDayOf(utc('2026-11-30T23:30:00'))).toBe(1);
    expect(chargeDayOf(utc('2027-01-31T10:00:00'))).toBe(28);
  });

  it('el siguiente cobro es el próximo día de cobro que aún no ha pasado, también al cambiar de año', () => {
    expect(nextChargeAt(utc('2026-11-07T10:00:00'), 7)).toEqual(utc('2026-12-07T00:00:00'));
    expect(nextChargeAt(utc('2026-11-03T10:00:00'), 7)).toEqual(utc('2026-11-07T00:00:00'));
    expect(nextChargeAt(utc('2026-12-20T07:00:00'), 5)).toEqual(utc('2027-01-05T00:00:00'));
    // Febrero también tiene día 28.
    expect(nextChargeAt(utc('2027-01-28T07:00:00'), 28)).toEqual(utc('2027-02-28T00:00:00'));
  });

  it('un primer pago de madrugada en España no adelanta el segundo cobro al mismo día (auditoría B1)', () => {
    for (const paidAt of ['2026-11-30T23:30:00', '2026-11-04T23:30:00', '2026-06-04T22:30:00', '2026-11-04T23:00:00']) {
      const first = utc(paidAt);
      const next = nextChargeAt(first, chargeDayOf(first));
      expect(next.getTime() - first.getTime(), paidAt).toBeGreaterThan(25 * 86_400_000);
    }
    expect(nextChargeAt(utc('2026-11-30T23:30:00'), chargeDayOf(utc('2026-11-30T23:30:00')))).toEqual(utc('2027-01-01T00:00:00'));
  });

  it('el día de cobro a las 07:00 UTC ya cuenta como cobrado: el siguiente es el mes que viene', () => {
    expect(nextChargeAt(utc('2026-11-05T07:00:00'), 5)).toEqual(utc('2026-12-05T00:00:00'));
  });

  it('tras una pausa larga no hay meses atrasados: siempre se calcula desde ahora', () => {
    expect(nextChargeAt(utc('2027-04-10T09:00:00'), 7)).toEqual(utc('2027-05-07T00:00:00'));
  });

  it('rechaza un día de cobro imposible', () => {
    expect(() => nextChargeAt(new Date(), 0)).toThrow(RangeError);
    expect(() => nextChargeAt(new Date(), 29)).toThrow(RangeError);
  });
});

describe('Campaña de cada mes', () => {
  const now = utc('2026-11-07T07:00:00');
  const open = [
    { id: 3, closesAt: utc('2026-12-20T00:00:00') },
    { id: 1, closesAt: utc('2026-12-01T00:00:00') },
    { id: 2, closesAt: utc('2026-12-01T00:00:00') },
    { id: 9, closesAt: utc('2026-11-01T00:00:00') }
  ];

  it('va a la preferida mientras recauda', () => {
    expect(pickPledgeCampaign(open, 3, now)?.id).toBe(3);
  });

  it('si la preferida ya no recauda (o no hay), va a la que antes cierre; a igualdad, la más antigua', () => {
    expect(pickPledgeCampaign(open, 9, now)?.id).toBe(1);
    expect(pickPledgeCampaign(open, null, now)?.id).toBe(1);
    expect(pickPledgeCampaign(open, 42, now)?.id).toBe(1);
  });

  it('sin ninguna campaña abierta, ese mes no hay cobro', () => {
    expect(pickPledgeCampaign([{ id: 9, closesAt: utc('2026-11-01T00:00:00') }], null, now)).toBeNull();
    expect(pickPledgeCampaign([], null, now)).toBeNull();
  });
});

describe('Lo que acepta el servidor', () => {
  const valid = { orgSlug: 'ceip-sol', initiativeId: null, amountCents: 1_000, months: 9, fiscal: null, locale: 'es' };

  it('solo importes entre el mínimo y el máximo, y solo las duraciones ofrecidas', () => {
    expect(pledgeInputSchema.safeParse(valid).success).toBe(true);
    expect(pledgeInputSchema.safeParse({ ...valid, amountCents: PLEDGE_MIN_CENTS - 1 }).success).toBe(false);
    expect(pledgeInputSchema.safeParse({ ...valid, amountCents: PLEDGE_MAX_CENTS + 1 }).success).toBe(false);
    expect(pledgeInputSchema.safeParse({ ...valid, amountCents: 10.5 }).success).toBe(false);
    expect(pledgeInputSchema.safeParse({ ...valid, months: 4 }).success).toBe(false);
    expect(pledgeInputSchema.safeParse({ ...valid, months: 12 }).success).toBe(true);
  });

  it('el pedido de Mi Hucha es aleatorio, sin datos de la persona, y lo reconoce la página de pago', () => {
    const order = newPledgeOrder();
    expect(order).toMatch(/^KH[0-9A-F]{16}$/);
    expect(isCheckoutOrder(order)).toBe(true);
    expect(newPledgeOrder()).not.toBe(order);
  });
});

describe('Tarjeta guardada en la notificación del primer pago', () => {
  const secrets = { accountCode: 'KORUMOCK', terminal: '1', password: 'contraseña-de-pruebas' };
  const mock = new MockPaycometProvider({ secrets });

  it('se entrega aparte para cifrarla y nunca entra en lo que se guarda del webhook', () => {
    const card = mock.savedCardFor('KH0123456789ABCDEF');
    const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order: 'KH0123456789ABCDEF', amountCents: 1_025, card });
    const check = mock.verifyNotification(rawBody, contentType);
    expect(check.valid).toBe(true);
    if (!check.valid) return;
    expect(check.notification.card).toEqual({ idUser: card.idUser, tokenUser: card.tokenUser, brand: 'VISA' });
    expect(JSON.stringify(check.notification.payload)).not.toContain(card.tokenUser);
    expect(check.notification.payload).not.toHaveProperty('IdUser');
  });

  it('un pago normal no trae tarjeta', () => {
    const { rawBody, contentType } = mock.buildNotification({ kind: 'PAYMENT', order: 'KD0123456789ABCDEF', amountCents: 2_500 });
    const check = mock.verifyNotification(rawBody, contentType);
    expect(check.valid && check.notification.card).toBeNull();
  });
});
