import { afterEach, describe, expect, it } from 'vitest';
import { buildCheckoutPayload, clearDraft, donationCents, draftFromHint, guaranteeCents, initialDraft, loadDraft, saveDraft, type CheckoutOffer } from '@/components/checkout/checkout-draft';
import {
  acceptedGroup,
  canIssueTaxCertificate,
  checkoutInputSchema,
  checkoutOutcome,
  guaranteeChoices,
  isTrustedChallengeUrl,
  newDonationOrder,
  PENDING_CONFIRMATION_MS,
  signCheckoutResult,
  signPaymentSimulator,
  spanishFiscalYear,
  verifyCheckoutResult,
  verifyPaymentSimulator
} from '@/core/checkout/checkout-rules';
import { donationSummary, maxSelectableTickets, ticketSummary } from '@/core/checkout/checkout-summary';
import { calculateStudioTicketingTCO } from '@/core/finance/tco.service';
import { orderedGroupClusters, orderedGroupNames } from '@/core/public/course-challenge';
import { seatHoldLimit } from '@/lib/rate-limit-rules';

/** QA-F04 · QA-F07 · QA-F10 · reglas puras del checkout y del borrador que se recupera tras un pago rechazado. */

const SECRET = 'secreto-unitario-del-checkout-0123456789abcdef';

const offer = (overrides: Partial<CheckoutOffer> = {}): CheckoutOffer => ({
  orgSlug: 'cervantes',
  initiativeId: 1,
  title: 'Toldos',
  legalName: 'AFA CEIP Cervantes',
  vertical: 'SCHOOL',
  kind: 'DONATION',
  closedReason: null,
  donation: { presetsCents: [1_000, 2_500, 5_000], defaultIdx: 1 },
  ticket: null,
  groups: orderedGroupClusters('SCHOOL', null),
  initialGroup: null,
  plaque: false,
  guarantee: { suggestedCents: 180, choicesCents: guaranteeChoices([0, 100, 200, 400], 180) },
  certificate: true,
  provinces: [{ code: '08', name: 'Barcelona' }],
  sessionEmail: null,
  ...overrides
});

afterEach(() => window.sessionStorage.clear());

describe('QA-F04 · lo que se ofrece', () => {
  it('la aportación voluntaria arranca DESMARCADA y a 0 € en el cobro, aunque el título enseñe el importe sugerido', () => {
    const draft = initialDraft(offer());
    expect(draft.guaranteeOn).toBe(false);
    expect(draft.guaranteeCents).toBe(180);
    expect(guaranteeCents(draft)).toBe(0);
    expect(donationCents(offer(), draft, 'es')).toBe(2_500);
    expect(donationSummary(2_500, guaranteeCents(draft))).toMatchObject({ totalCents: 2_500, guaranteeCents: 0, valid: true });
  });

  it('el selector manual va desde 0 €, ordenado, sin repetir y con el sugerido', () => {
    expect(guaranteeChoices([0, 100, 200, 400], 180)).toEqual([0, 100, 180, 200, 400]);
    expect(guaranteeChoices([400, 100, 100], 99_999)).toEqual([0, 100, 400]);
  });

  it('13 cursos + 2 de comunidad en el colegio, equipos y afición en el club, grupos en la cultural', () => {
    const school = orderedGroupNames('SCHOOL', null);
    expect(school).toHaveLength(15);
    expect(school.slice(0, 3)).toEqual(['Infantil 3 años (I3)', 'Infantil 4 años (I4)', 'Infantil 5 años (I5)']);
    expect(school.slice(-2)).toEqual(['Vecino / Amigo del Barrio', 'Antiguo Alumno / Familiar']);
    expect(orderedGroupNames('SPORTS_CLUB', null)).toEqual(['Prebenjamín', 'Benjamín', 'Alevín', 'Infantil', 'Cadete', 'Juvenil / Júnior', 'Sénior / Primer Equipo', 'Escuela / Veteranos', 'Socio / Afición', 'Antiguo Jugador / Familiar']);
    expect(orderedGroupNames('CULTURAL', null)).toEqual(['Alumnado / Integrantes', 'Familias', 'Profesorado / Monitores', 'Socios / Amigos', 'Antiguos Miembros']);
    expect(orderedGroupClusters('SCHOOL', null).map((cluster) => cluster.items.length)).toEqual([3, 6, 4, 2]);
  });

  it('el certificado (y el NIF) solo existe con la Ley 49/2002 declarada y verificada', () => {
    expect(canIssueTaxCertificate({ ley49: true, ley49VerifiedAt: new Date() })).toBe(true);
    expect(canIssueTaxCertificate({ ley49: true, ley49VerifiedAt: null })).toBe(false);
    expect(canIssueTaxCertificate({ ley49: false, ley49VerifiedAt: new Date() })).toBe(false);
  });

  it('solo se acepta un grupo de la entidad y con el reto activo', () => {
    const names = orderedGroupNames('SCHOOL', null);
    expect(acceptedGroup('3º de Primaria', true, names)).toBe('3º de Primaria');
    expect(acceptedGroup('3º de Primaria', false, names)).toBeNull();
    expect(acceptedGroup('Mamá de Lucas', true, names)).toBeNull();
  });
});

describe('Validación de lo que llega del navegador', () => {
  const base = { kind: 'DONATION', orgSlug: 'cervantes', initiativeId: 1, locale: 'es', method: 'BIZUM', groupName: null, email: 'a@b.example', amountCents: 2_500, guaranteeCents: 0, fiscal: null };

  it('rechaza decimales, negativos, métodos desconocidos y cantidades de entradas fuera de rango', () => {
    expect(checkoutInputSchema.safeParse(base).success).toBe(true);
    expect(checkoutInputSchema.safeParse({ ...base, amountCents: 2_500.5 }).success).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...base, guaranteeCents: -1 }).success).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...base, method: 'HUCHA' }).success).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...base, method: 'IBAN' }).success).toBe(false);
    const ticket = { kind: 'TICKET', orgSlug: 'cervantes', initiativeId: 2, locale: 'es', method: 'CARD', groupName: null, email: 'a@b.example' };
    expect(checkoutInputSchema.safeParse({ ...ticket, quantity: 0 }).success).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...ticket, quantity: 21 }).success).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...ticket, quantity: 20 }).success).toBe(true);
  });

  it('solo se envía a la familia a páginas https de Paycomet', () => {
    expect(isTrustedChallengeUrl('https://api.paycomet.com/gateway/form/1')).toBe(true);
    expect(isTrustedChallengeUrl('https://paycomet.com/pay')).toBe(true);
    expect(isTrustedChallengeUrl('http://api.paycomet.com/pay')).toBe(false);
    expect(isTrustedChallengeUrl('https://paycomet.com.evil.example/pay')).toBe(false);
    expect(isTrustedChallengeUrl('https://evilpaycomet.com/pay')).toBe(false);
    expect(isTrustedChallengeUrl('https://user:pw@api.paycomet.com/pay')).toBe(false);
    expect(isTrustedChallengeUrl('javascript:alert(1)')).toBe(false);
  });

  it('pedidos aleatorios y firmas separadas para el resultado y el simulador', () => {
    const order = newDonationOrder();
    expect(order).toMatch(/^KD[0-9A-F]{16}$/);
    expect(newDonationOrder()).not.toBe(order);
    expect(verifyCheckoutResult(SECRET, order, signCheckoutResult(SECRET, order))).toBe(true);
    expect(verifyPaymentSimulator(SECRET, order, signCheckoutResult(SECRET, order))).toBe(false);
    expect(verifyCheckoutResult(SECRET, order, signPaymentSimulator(SECRET, order))).toBe(false);
    expect(verifyCheckoutResult(SECRET, 'KD0000000000000000', signCheckoutResult(SECRET, order))).toBe(false);
    expect(verifyCheckoutResult(SECRET, 'pedido-raro', signCheckoutResult(SECRET, 'pedido-raro'))).toBe(false);
  });

  it('el ejercicio fiscal es el año en España: el 1 de enero a las 00:30 ya es el año nuevo', () => {
    expect(spanishFiscalYear(new Date('2026-12-31T23:30:00Z'))).toBe(2027);
    expect(spanishFiscalYear(new Date('2026-12-31T22:30:00Z'))).toBe(2026);
  });

  it('el estado de la vuelta sale de lo guardado: un pendiente de más de 30 min no se presenta como en curso', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    expect(checkoutOutcome('COMPLETED', now, now)).toBe('CONFIRMED');
    expect(checkoutOutcome('FAILED', now, now)).toBe('FAILED');
    expect(checkoutOutcome('PENDING', new Date(now.getTime() - 60_000), now)).toBe('PENDING');
    expect(checkoutOutcome('PENDING', new Date(now.getTime() - PENDING_CONFIRMATION_MS - 1), now)).toBe('UNCONFIRMED');
    expect(checkoutOutcome('REFUND_PENDING', now, now)).toBe('RETURNED');
  });
});

describe('QA-F07 · el resumen de la taquilla coincide con el cobro del servidor', () => {
  it('ADD y INC: mismas cifras que calculateStudioTicketingTCO para 1 a 20 entradas', () => {
    for (const mode of ['ADD', 'INC'] as const) {
      for (const priceCents of [100, 500, 1_250]) {
        const unit = calculateStudioTicketingTCO({ ticketPriceCents: priceCents, ticketMax: 1, feeMode: mode, digitalFeeConfig: { fixedCents: 45, pctBps: 200 }, gatewayConfig: { pctBps: 0, fixedCents: 0 }, maintFeeCents: 0 });
        for (let quantity = 1; quantity <= 20; quantity += 1) {
          const server = calculateStudioTicketingTCO({ ticketPriceCents: priceCents, ticketMax: quantity, feeMode: mode, digitalFeeConfig: { fixedCents: 45, pctBps: 200 }, gatewayConfig: { pctBps: 100, fixedCents: 9 }, maintFeeCents: 0 });
          const amount = mode === 'ADD' ? server.grossTicketsCents : server.grossTicketsCents - server.totalDigitalFeesCents;
          const summary = ticketSummary(quantity, { mode, priceCents, feeUnitCents: unit.digitalFeeUnitCents, buyerUnitCents: unit.buyerUnitChargeCents }, 200);
          expect(summary.totalCents).toBe(amount + server.totalDigitalFeesCents);
        }
      }
    }
  });

  it('plazas que una misma red puede retener: un cuarto del aforo, al menos una compra de 20 y nunca todo el aforo si es grande', () => {
    expect(seatHoldLimit(200)).toBe(50);
    expect(seatHoldLimit(1_000)).toBe(250);
    expect(seatHoldLimit(100)).toBe(25);
    expect(seatHoldLimit(40)).toBe(20);
    expect(seatHoldLimit(12)).toBe(12);
    expect(seatHoldLimit(0)).toBe(1);
  });

  it('nunca se pueden elegir más plazas que las que quedan ni más de 20', () => {
    expect(maxSelectableTickets(4)).toBe(4);
    expect(maxSelectableTickets(500)).toBe(20);
    expect(maxSelectableTickets(-3)).toBe(0);
    expect(ticketSummary(5, { mode: 'ADD', priceCents: 500, feeUnitCents: 55, buyerUnitCents: 555 }, 4).valid).toBe(false);
  });
});

describe('QA-F10 · reintentar sin perder lo introducido (y sin guardar el NIF)', () => {
  it('se recupera lo elegido con el otro método, pero el NIF nunca llega al navegador', () => {
    const current = offer();
    const draft = { ...initialDraft(current), presetIdx: null, customAmount: '30', groupName: '3º de Primaria', guaranteeOn: true, guaranteeCents: 200, email: 'madre@familia.example', wantsCertificate: true, fullName: 'GARCÍA, ANA', provinceCode: '08' };
    saveDraft(current.initiativeId, draft);
    expect(window.sessionStorage.getItem('korum:checkout:1')).not.toMatch(/\d{8}[A-Z]/);
    const restored = loadDraft(current, 'CARD');
    expect(restored).toMatchObject({ customAmount: '30', groupName: '3º de Primaria', guaranteeOn: true, guaranteeCents: 200, email: 'madre@familia.example', wantsCertificate: true, method: 'CARD' });
    expect(buildCheckoutPayload(current, restored!, '12345678Z', 'es', 'CARD')).toMatchObject({ kind: 'DONATION', amountCents: 3_000, guaranteeCents: 200, groupName: '3º de Primaria', fiscal: { taxId: '12345678Z', provinceCode: '08' } });
  });

  it('sin sessionStorage (otra pestaña), la URL de reintento recupera importe, aportación voluntaria y cantidad', () => {
    expect(draftFromHint(offer(), { amountCents: 1_250, guaranteeCents: 100, quantity: null }, 'CARD', 'es')).toMatchObject({ presetIdx: null, customAmount: '12,50', guaranteeOn: true, guaranteeCents: 100, method: 'CARD' });
    expect(draftFromHint(offer(), { amountCents: 5_000, guaranteeCents: 0, quantity: null }, null, 'en')).toMatchObject({ presetIdx: 2, customAmount: '', guaranteeOn: false, guaranteeCents: 180 });
    expect(draftFromHint(offer(), { amountCents: 1_200, guaranteeCents: 999_999, quantity: null }, null, 'en')).toMatchObject({ customAmount: '12', guaranteeCents: 5_000 });
    const tickets = offer({ kind: 'TICKET', donation: null, ticket: { subtype: 'EVENT', available: 3, max: 200, venue: null, pricing: { mode: 'ADD', priceCents: 500, feeUnitCents: 55, buyerUnitCents: 555 } } });
    expect(draftFromHint(tickets, { amountCents: null, guaranteeCents: null, quantity: 9 }, null, 'es').quantity).toBe(3);
  });

  it('tras pagar, el borrador (email y nombre) se borra del navegador', () => {
    saveDraft(1, { ...initialDraft(offer()), email: 'madre@familia.example' });
    clearDraft(1);
    expect(window.sessionStorage.getItem('korum:checkout:1')).toBeNull();
  });

  it('lo guardado manipulado se descarta campo a campo', () => {
    window.sessionStorage.setItem('korum:checkout:1', JSON.stringify({ presetIdx: 99, groupName: 'Inventado', guaranteeCents: 999_999, provinceCode: '99', email: 'x@y.example', quantity: 'muchas' }));
    const restored = loadDraft(offer({ sessionEmail: 'cuenta@familia.example' }), null);
    expect(restored).toMatchObject({ presetIdx: 1, groupName: '', guaranteeCents: 5_000, provinceCode: '', email: '', method: 'BIZUM' });
    window.sessionStorage.setItem('korum:checkout:1', '{roto');
    expect(loadDraft(offer(), null)).toBeNull();
  });

  it('en taquilla la petición solo lleva la cantidad: el precio lo pone el servidor', () => {
    const ticketOffer = offer({ kind: 'TICKET', donation: null, ticket: { subtype: 'EVENT', available: 4, max: 200, venue: 'Patio', pricing: { mode: 'ADD', priceCents: 500, feeUnitCents: 55, buyerUnitCents: 555 } } });
    const payload = buildCheckoutPayload(ticketOffer, { ...initialDraft(ticketOffer), quantity: 2 }, '', 'ca', 'BIZUM');
    expect(payload).toEqual({ kind: 'TICKET', orgSlug: 'cervantes', initiativeId: 1, locale: 'ca', method: 'BIZUM', groupName: null, email: '', quantity: 2 });
  });
});
