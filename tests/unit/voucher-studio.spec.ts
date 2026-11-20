import { describe, expect, it } from 'vitest';
import { buildCheckoutPayload, initialDraft, maxQuantity, type CheckoutOffer } from '@/components/checkout/checkout-draft';
import { checkoutInputSchema, isCheckoutOrder } from '@/core/checkout/checkout-rules';
import { maxSelectableVouchers, voucherSummary } from '@/core/checkout/checkout-summary';
import { toCardData, type InitiativeRow } from '@/core/public/view-model';
import { computeStudioBoard, maxDaysFor, publishBlockers, saveProblems, type StudioContext } from '@/core/studio/studio-board';
import { blankStudioDraft, defaultVoucherValidOn, latestVoucherValidOn, studioDraftSchema, TICKETING_CATEGORY, type StudioDraft } from '@/core/studio/studio-draft';
import { computeVoucherBoard } from '@/core/studio/voucher-board';
import { voucherCharge } from '@/core/ticketing/voucher-rules';
import { voucherHoldLimit } from '@/lib/rate-limit-rules';

/**
 * QA-VAL03 (Sprint 5.14b) · reglas puras de la venta de vales: borrador y pizarra del Estudio, validez (por defecto hasta el inicio del curso siguiente, entre el
 * cierre y 12 meses después), objetivo orientativo sin tope, lo que enseña la ficha y el resumen del pago, con las mismas fórmulas que el motor (`voucherCharge`).
 */

const NOW = new Date('2026-11-20T10:00:00.000Z');

const context = (overrides: Partial<StudioContext> = {}): StudioContext => ({
  vertical: 'SCHOOL',
  bracket: { mode: 'FLAT', t1MaxCents: 500_000, t2MaxCents: 1_500_000, ratesBps: { t1: 500, t2: 400, t3: 300 } },
  gateway: { pctBps: 100, fixedCents: 9 },
  donationTicketCents: 2500,
  exemptRemainingCents: 100_000,
  medalGrantAvailableCents: 0,
  medalRank: 0,
  maint: { active: false, perInitCents: 4900, annualCapCents: 14_700, paidCents: 0 },
  ticketFee: { fixedCents: 45, pctBps: 200 },
  voucherFee: { fixedCents: 45, pctBps: 200 },
  forProfitSchool: false,
  maxCampaignDays: 60,
  categories: [{ name: TICKETING_CATEGORY, icon: '🎟️', rule: 'EXEMPT' }],
  kybVerified: true,
  ...overrides
});

const sale = (overrides: Partial<StudioDraft> = {}): StudioDraft => ({
  ...blankStudioDraft('TICKETING', 'SCHOOL', '2026-12-10', 'VOUCHER'),
  title: 'Vales de la merienda',
  description: 'Un vale, una merienda en el puesto del AFA.',
  ...overrides
});

describe('validez de los vales', () => {
  it('por defecto, hasta el inicio del curso siguiente: el primer 1 de septiembre posterior al cierre', () => {
    expect(defaultVoucherValidOn('2026-12-10')).toBe('2027-09-01');
    expect(defaultVoucherValidOn('2027-03-15')).toBe('2027-09-01');
    expect(defaultVoucherValidOn('2027-08-31')).toBe('2027-09-01');
    // El mismo 1 de septiembre ya es del curso nuevo: el siguiente es el del año que viene.
    expect(defaultVoucherValidOn('2027-09-01')).toBe('2028-09-01');
    expect(defaultVoucherValidOn('no-es-fecha')).toBe('');
  });

  it('como mucho 12 meses después del cierre, sin inventar días (un 29 de febrero se queda en el último día del mes)', () => {
    expect(latestVoucherValidOn('2026-12-10')).toBe('2027-12-10');
    expect(latestVoucherValidOn('2028-02-29')).toBe('2029-02-28');
    expect(latestVoucherValidOn('2026-01-31')).toBe('2027-01-31');
  });

  it('la de por defecto siempre cabe entre el cierre y el máximo', () => {
    for (let day = 0; day < 400; day += 7) {
      const closesOn = new Date(Date.UTC(2026, 10, 20 + day)).toISOString().slice(0, 10);
      const validOn = defaultVoucherValidOn(closesOn);
      expect(validOn >= closesOn && validOn <= latestVoucherValidOn(closesOn), closesOn).toBe(true);
    }
  });

  it('el Estudio no guarda una validez anterior al cierre, posterior a 12 meses ni vacía', () => {
    const problems = (validOn: string | null) => saveProblems(context(), sale({ voucherValidOn: validOn }), NOW);
    expect(problems('2026-12-10')).toEqual([]);
    expect(problems('2026-12-09')).toContain('VALIDITY_BEFORE_CLOSE');
    expect(problems('2027-12-11')).toContain('VALIDITY_TOO_LATE');
    expect(problems(null)).toContain('VALIDITY_INVALID');
    expect(problems('2027-02-30')).toContain('VALIDITY_INVALID');
    // Un evento no tiene validez: no se le pide.
    expect(saveProblems(context(), { ...sale({ voucherValidOn: null }), ticketSubtype: 'EVENT' }, NOW)).not.toContain('VALIDITY_INVALID');
  });

  it('una venta de vales dura como mucho 60 días aunque el motor de reglas admita más (decisión 32)', () => {
    const generous = context({ maxCampaignDays: 75 });
    expect(maxDaysFor(generous, sale())).toBe(60);
    expect(maxDaysFor(generous, { format: 'TICKETING', ticketSubtype: 'EVENT' })).toBe(75);
    expect(saveProblems(generous, sale({ closesOn: '2027-01-25', voucherValidOn: '2027-09-01' }), NOW)).toContain('CLOSING_TOO_LATE');
  });
});

describe('borrador del Estudio', () => {
  it('una venta de vales en blanco: 2 € por vale, con tope, validez por defecto, sin reto por curso ni placa y sin «sin producto»', () => {
    const draft = blankStudioDraft('TICKETING', 'SCHOOL', '2026-12-10', 'VOUCHER');
    expect(draft).toMatchObject({ ticketSubtype: 'VOUCHER', ticketPriceCents: 200, voucherCapped: true, voucherValidOn: '2027-09-01', rewardEnabled: false, plaqueEnabled: false, voucherNoProductEnabled: false });
    expect(studioDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('un borrador de antes del 5.14b (sin los campos de vales) sigue siendo válido, con sus valores por defecto', () => {
    const { voucherCapped, voucherTargetCount, voucherValidOn, voucherNoProductEnabled, ...legacy } = blankStudioDraft('BUDGET', 'SCHOOL', '2026-12-10');
    expect([voucherCapped, voucherTargetCount, voucherValidOn, voucherNoProductEnabled]).toEqual([true, 0, null, false]);
    const parsed = studioDraftSchema.parse(legacy);
    expect(parsed).toMatchObject({ voucherCapped: true, voucherTargetCount: 0, voucherValidOn: null, voucherNoProductEnabled: false });
  });

  it('rechaza un tipo de taquilla desconocido y una validez mal escrita', () => {
    expect(studioDraftSchema.safeParse({ ...sale(), ticketSubtype: 'OTRO' }).success).toBe(false);
    expect(studioDraftSchema.safeParse({ ...sale(), voucherValidOn: '1/9/2027' }).success).toBe(false);
    expect(studioDraftSchema.safeParse({ ...sale(), voucherTargetCount: -1 }).success).toBe(false);
  });
});

describe('pizarra de vales', () => {
  it('con tope y gastos sumados: la meta es el precio de todos los vales y la entidad recibe eso si no hay mantenimiento', () => {
    const board = computeVoucherBoard(context(), sale({ ticketPriceCents: 200, ticketMax: 300, ticketFeeMode: 'ADD' }));
    expect(board).toMatchObject({ kind: 'VOUCHER', capped: true, units: 300, grossCents: 60_000, goalCents: 60_000, netCents: 60_000, maintFeeCents: 0 });
    // 0,45 € + 2 % de 2 € = 0,49 € en una compra de un vale; 0,45 € + 2 % de 100 € = 2,45 € en una de 50.
    expect(board.feeOneCents).toBe(49);
    expect(board.buyerOneCents).toBe(249);
    expect(board.feeLargestCents).toBe(245);
    expect(board.largestQuantity).toBe(50);
    expect(board.totalDigitalFeesCents).toBe(49 * 300);
  });

  it('con gastos incluidos: la meta supone una compra por vale (lo mínimo que recibe la entidad si se vende todo)', () => {
    const board = computeVoucherBoard(context(), sale({ ticketPriceCents: 200, ticketMax: 300, ticketFeeMode: 'INC' }));
    expect(board.goalCents).toBe((200 - 49) * 300);
    // Comprar 300 vales de uno en uno deja exactamente la meta; comprarlos de 50 en 50 deja más.
    const one = voucherCharge({ priceCents: 200, quantity: 1, feeMode: 'INC', fee: { fixedCents: 45, pctBps: 200 } });
    const fifty = voucherCharge({ priceCents: 200, quantity: 50, feeMode: 'INC', fee: { fixedCents: 45, pctBps: 200 } });
    expect(one.amountCents * 300).toBe(board.goalCents);
    expect(fifty.amountCents * 6).toBeGreaterThan(board.goalCents);
  });

  it('con gastos incluidos y sin fijo, la meta sigue siendo un mínimo real aunque el redondeo del porcentaje favorezca a la compra de un vale (auditoría financiera)', () => {
    const fee = { fixedCents: 0, pctBps: 150 };
    const draft = sale({ ticketPriceCents: 230, ticketMax: 300, ticketFeeMode: 'INC' });
    const board = computeVoucherBoard(context({ voucherFee: fee }), draft);
    // 1 vale: 3,45 cts → 3, llegan 227; 2 vales: 6,9 cts → 7, llegan 453 (226,5 por vale). La meta usa 226 por vale, no 227.
    expect(board.goalCents).toBe(226 * 300);
    for (let quantity = 1; quantity <= 50; quantity += 1) {
      const perVoucher = voucherCharge({ priceCents: 230, quantity, feeMode: 'INC', fee }).amountCents / quantity;
      expect(perVoucher * 300, `${quantity} vales`).toBeGreaterThanOrEqual(board.goalCents);
    }
  });

  it('sin tope, la meta y la barra salen del objetivo orientativo', () => {
    const board = computeStudioBoard(context(), sale({ voucherCapped: false, voucherTargetCount: 120, ticketMax: 999 }));
    expect(board.kind).toBe('VOUCHER');
    expect(board).toMatchObject({ capped: false, units: 120, goalCents: 24_000 });
  });

  it('el mantenimiento se compara con la meta: si no la cubre, no se publica', () => {
    const withMaint = context({ maint: { active: true, perInitCents: 4900, annualCapCents: 14_700, paidCents: 0 } });
    const small = sale({ ticketPriceCents: 100, ticketMax: 20 });
    const board = computeStudioBoard(withMaint, small);
    expect(board.kind === 'VOUCHER' && board.maintShortfallCents).toBe(4900 - 2000);
    expect(publishBlockers(withMaint, small, board, NOW)).toContain('MAINT_EXCEEDS_TAKINGS');
    const big = sale({ ticketPriceCents: 200, ticketMax: 300 });
    expect(publishBlockers(withMaint, big, computeStudioBoard(withMaint, big), NOW)).toEqual([]);
  });

  it('avisa si la gestión no paga la pasarela en la compra más pequeña o en la más grande', () => {
    expect(computeVoucherBoard(context(), sale()).isGatewayCovered).toBe(true);
    // Sin fijo, una compra de un vale de 2 € deja 4 céntimos de gestión y la pasarela cuesta 9 + 1 %: no la cubre.
    expect(computeVoucherBoard(context({ voucherFee: { fixedCents: 0, pctBps: 200 } }), sale()).isGatewayCovered).toBe(false);
    // Con un porcentaje menor que el de la pasarela, la compra más grande no se cubre aunque la pequeña sí.
    const thin = computeVoucherBoard(context({ voucherFee: { fixedCents: 40, pctBps: 50 } }), sale({ ticketPriceCents: 10_000 }));
    expect(thin.isGatewayCovered).toBe(false);
  });

  it('qué impide publicar: tope u objetivo a cero, precio a cero y gastos incluidos que se comen el precio', () => {
    const blockersOf = (draft: StudioDraft) => publishBlockers(context(), draft, computeStudioBoard(context(), draft), NOW);
    expect(blockersOf(sale())).toEqual([]);
    expect(blockersOf(sale({ ticketMax: 0 }))).toContain('VOUCHER_MAX_ZERO');
    expect(blockersOf(sale({ voucherCapped: false, voucherTargetCount: 0 }))).toContain('VOUCHER_TARGET_ZERO');
    expect(blockersOf(sale({ ticketPriceCents: 0 }))).toContain('TICKET_PRICE_ZERO');
    expect(blockersOf(sale({ ticketPriceCents: 46, ticketFeeMode: 'INC' }))).toContain('TICKET_FEE_EXCEEDS_PRICE');
    expect(blockersOf(sale({ ticketPriceCents: 50, ticketFeeMode: 'INC' }))).not.toContain('TICKET_FEE_EXCEEDS_PRICE');
  });
});

const row = (overrides: Partial<InitiativeRow> = {}): InitiativeRow => ({
  id: 9,
  status: 'FUNDRAISING',
  walletEscrowId: 'WLT-ESC-302',
  format: 'TICKETING',
  title: 'Vales de la cantina',
  category: TICKETING_CATEGORY,
  stage: 'Todo el club',
  description: 'Un vale, un bocadillo.',
  closesAt: new Date('2026-12-05T22:59:00.000Z'),
  raisedCents: 12_000,
  goalCents: 60_000,
  totalContributions: 24,
  showPublicBreakdown: true,
  matchingPoolRemainingCents: 0,
  matchingSponsorName: null,
  ticketSubtype: 'VOUCHER',
  ticketPriceCents: 200,
  ticketMax: 300,
  ticketsSold: 60,
  ticketsHeld: 0,
  ticketFeeMode: 'ADD',
  ticketVenue: null,
  voucherValidUntil: new Date('2027-01-10T22:59:00.000Z'),
  voucherNoProductEnabled: true,
  voucherTargetCount: null,
  plaqueEnabled: false,
  rewardEnabled: false,
  rewardText: null,
  targetFamiliesPerCourse: 35,
  costMatCents: 0,
  costInstCents: 0,
  contingencyBps: 0,
  bracketFeeCents: 0,
  maintFeeCents: 0,
  quotaReservedAt: new Date('2026-10-04T00:00:00.000Z'),
  courses: [],
  ...overrides
});

const fees = { ticketFeeFixedCents: 45, ticketFeeBps: 200, voucherFeeFixedCents: 45, voucherFeeBps: 200, legalForm: 'SPORTS_ENTITY' };

describe('ficha pública de una venta de vales', () => {
  it('con tope: avance en vales, los que quedan, el precio de un vale con sus gastos y la validez', () => {
    const card = toCardData(row(), NOW, fees);
    expect(card).toMatchObject({ subtype: 'VOUCHER', pct: 20, ticketsSold: 60, ticketMax: 300, ticketBuyerCents: 249, achieved: false, closed: false, matching: false, zeroCommission: false });
    expect(card.voucher).toMatchObject({ capped: true, units: 300, available: 240, priceCents: 200, buyerOneCents: 249, feeFixedCents: 45, feeBps: 200, noProduct: false, validUntilIso: '2027-01-10T22:59:00.000Z' });
  });

  it('sin tope: el avance se mide con el objetivo, que puede superarse, y nunca se agota', () => {
    const card = toCardData(row({ ticketMax: null, voucherTargetCount: 50 }), NOW, fees);
    expect(card.voucher).toMatchObject({ capped: false, units: 50, available: null });
    expect(card.pct).toBe(100);
    expect(card.achieved).toBe(false);
  });

  it('agotada de verdad y con «sin producto»: se ofrece seguir aportando; con vales retenidos por un pago en curso, todavía no', () => {
    expect(toCardData(row({ ticketsSold: 300 }), NOW, fees).voucher?.noProduct).toBe(true);
    expect(toCardData(row({ ticketsSold: 300 }), NOW, fees).achieved).toBe(true);
    expect(toCardData(row({ ticketsSold: 298, ticketsHeld: 2 }), NOW, fees).voucher?.noProduct).toBe(false);
    expect(toCardData(row({ ticketsSold: 300, voucherNoProductEnabled: false }), NOW, fees).voucher?.noProduct).toBe(false);
  });

  it('a un colegio con ánimo de lucro nunca se le ofrece «sin producto» (decisión 65)', () => {
    expect(toCardData(row({ ticketsSold: 300 }), NOW, { ...fees, legalForm: 'SCHOOL_OWNER' }).voucher?.noProduct).toBe(false);
  });

  it('pasada la validez o el cierre ya no se pueden comprar vales', () => {
    expect(toCardData(row({ voucherValidUntil: new Date('2026-11-19T00:00:00.000Z') }), NOW, fees).closed).toBe(true);
    expect(toCardData(row({ closesAt: new Date('2026-11-19T00:00:00.000Z') }), NOW, fees).closed).toBe(true);
  });

  it('un evento sigue como siempre: sin datos de vales', () => {
    const event = toCardData(row({ ticketSubtype: 'EVENT', voucherValidUntil: null }), NOW, fees);
    expect(event.voucher).toBeNull();
    expect(event.subtype).toBe('EVENT');
  });
});

const offer = (voucher: Partial<NonNullable<CheckoutOffer['voucher']>> = {}): CheckoutOffer => ({
  orgSlug: 'basket-valles',
  initiativeId: 9,
  title: 'Vales de la cantina',
  legalName: 'Club Deportiu Basket Vallès',
  vertical: 'SPORTS_CLUB',
  kind: 'VOUCHER',
  closedReason: null,
  donation: null,
  ticket: null,
  voucher: { capped: true, available: 240, units: 300, validUntilIso: '2027-01-10T22:59:00.000Z', noProduct: false, pricing: { mode: 'ADD', priceCents: 200, fee: { fixedCents: 45, pctBps: 200 } }, ...voucher },
  groups: [],
  initialGroup: null,
  plaque: false,
  guarantee: { suggestedCents: 180, choicesCents: [0, 180] },
  certificate: false,
  provinces: [],
  sessionEmail: null
});

describe('pago de vales', () => {
  it('el resumen usa la fórmula del motor: los gastos se cobran una vez por compra', () => {
    const pricing = offer().voucher!.pricing;
    expect(voucherSummary(3, pricing, 240)).toEqual({ kind: 'VOUCHER', quantity: 3, vouchersCents: 600, feeCents: 57, totalCents: 657, valid: true });
    expect(voucherSummary(3, { ...pricing, mode: 'INC' }, 240)).toEqual({ kind: 'VOUCHER', quantity: 3, vouchersCents: 600, feeCents: 0, totalCents: 600, valid: true });
    expect(voucherSummary(0, pricing, 240).valid).toBe(false);
    expect(voucherSummary(51, pricing, 240).valid).toBe(false);
    expect(voucherSummary(5, pricing, 4).valid).toBe(false);
  });

  it('se eligen hasta 50 vales por compra, nunca más de los que quedan; «sin producto» no consume vales', () => {
    expect(maxSelectableVouchers(240, false)).toBe(50);
    expect(maxSelectableVouchers(3, false)).toBe(3);
    expect(maxSelectableVouchers(null, false)).toBe(50);
    expect(maxSelectableVouchers(0, true)).toBe(50);
    expect(maxQuantity(offer({ available: 2 }))).toBe(2);
    expect(initialDraft(offer()).quantity).toBe(1);
  });

  it('la petición lleva el modo y nunca un grupo ni aportación voluntaria; el servidor la valida', () => {
    const draft = { ...initialDraft(offer()), quantity: 4, groupName: '3º de Primaria', email: 'familia@example.com' };
    const payload = buildCheckoutPayload(offer(), draft, '', 'es', 'BIZUM');
    expect(payload).toEqual({ kind: 'VOUCHER', orgSlug: 'basket-valles', initiativeId: 9, locale: 'es', method: 'BIZUM', groupName: null, email: 'familia@example.com', quantity: 4, mode: 'VOUCHERS' });
    expect(checkoutInputSchema.safeParse(payload).success).toBe(true);
    const noProduct = buildCheckoutPayload(offer({ noProduct: true, available: 0 }), draft, '', 'es', 'CARD');
    expect(noProduct).toMatchObject({ kind: 'VOUCHER', mode: 'NO_PRODUCT' });
    expect(checkoutInputSchema.safeParse({ ...payload, quantity: 51 }).success).toBe(false);
    expect(checkoutInputSchema.safeParse({ ...payload, mode: 'GRATIS' }).success).toBe(false);
  });

  it('la vuelta del pago reconoce los pedidos de vales (KV)', () => {
    expect(isCheckoutOrder('KV0123456789ABCDEF')).toBe(true);
    expect(isCheckoutOrder('KX0123456789ABCDEF')).toBe(false);
  });

  it('vales retenidos por red: un cuarto del tope, al menos una compra máxima y nunca más que el tope; sin tope, cuatro compras máximas', () => {
    expect(voucherHoldLimit(300, 50)).toBe(75);
    expect(voucherHoldLimit(100, 50)).toBe(50);
    expect(voucherHoldLimit(20, 50)).toBe(20);
    expect(voucherHoldLimit(null, 50)).toBe(200);
  });
});
