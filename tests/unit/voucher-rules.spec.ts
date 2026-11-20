import { describe, expect, it } from 'vitest';
import { buildBiInitiativeRow, type BiInitiativeFacts } from '@/core/finance/bi-aggregate';
import { evaluatePricingHealth, sampleVoucherMargin } from '@/core/finance/pricing-health';
import { selfBoostRejection } from '@/core/finance/self-boost';
import { eventChangeProblem } from '@/core/ticketing/event-schedule-rules';
import {
  isForProfitSchool,
  MAX_VOUCHERS_PER_ORDER,
  noProductOffered,
  voucherCharge,
  voucherFeeCents,
  voucherFeeMarginCents,
  VoucherPricingError,
  voucherRedeemBlock,
  voucherSaleBlock,
  vouchersAvailable,
  type VoucherSaleState
} from '@/core/ticketing/voucher-rules';
import type { KorumGlobalRulesCents } from '@/types/korum.types';
import seed from '@/mocks/seed_data.json';

/**
 * Sprint 5.14a · Reglas puras de los vales (QA-VAL01 en su parte sin base de datos): la tarifa propia va **por compra**, la aportación «sin producto»
 * solo se ofrece con la venta agotada y nunca en un colegio con ánimo de lucro, un vale caducado o de una venta cancelada no se gasta, y una venta de
 * vales no se trata como un evento (ni cancelación de evento, ni Auto-Impulso, ni 💎).
 */

const NOW = new Date('2026-12-01T10:00:00Z');
const DAY = 86_400_000;
const FEE = { fixedCents: 45, pctBps: 200 };
const GATEWAY = { pctBps: 100, fixedCents: 9 };

const sale = (overrides: Partial<VoucherSaleState> = {}): VoucherSaleState => ({
  status: 'FUNDRAISING',
  closesAt: new Date(NOW.getTime() + 10 * DAY),
  voucherValidUntil: new Date(NOW.getTime() + 20 * DAY),
  ticketPriceCents: 200,
  ticketFeeMode: 'ADD',
  ticketMax: 100,
  ticketsSold: 0,
  ticketsHeld: 0,
  voucherNoProductEnabled: true,
  legalForm: 'PARENTS_ASSOCIATION',
  ...overrides
});

describe('QA-VAL01 · lo que paga una compra de vales', () => {
  it('ADD: 5 vales de 2 € pagan un solo fijo por compra (45 cts + 2 % de 10 € = 65 cts) y la hucha recibe los 10 € íntegros', () => {
    expect(voucherCharge({ priceCents: 200, quantity: 5, feeMode: 'ADD', fee: FEE })).toEqual({ grossCents: 1_000, serviceFeeCents: 65, amountCents: 1_000, totalChargedCents: 1_065 });
  });

  it('INC: los gastos van dentro del importe y nunca se retiene más que él', () => {
    expect(voucherCharge({ priceCents: 200, quantity: 5, feeMode: 'INC', fee: FEE })).toEqual({ grossCents: 1_000, serviceFeeCents: 65, amountCents: 935, totalChargedCents: 1_000 });
    expect(voucherCharge({ priceCents: 10, quantity: 1, feeMode: 'INC', fee: FEE })).toEqual({ grossCents: 10, serviceFeeCents: 10, amountCents: 0, totalChargedCents: 10 });
  });

  it('el fijo no se multiplica por vale (a diferencia de las entradas): 1 vale y 50 vales pagan el mismo fijo', () => {
    expect(voucherFeeCents(100, FEE)).toBe(47);
    expect(voucherFeeCents(5_000, FEE)).toBe(145);
  });

  it('rechaza cantidades y precios imposibles', () => {
    for (const quantity of [0, -1, 1.5, MAX_VOUCHERS_PER_ORDER + 1, Number.NaN]) expect(() => voucherCharge({ priceCents: 200, quantity, feeMode: 'ADD', fee: FEE })).toThrow(VoucherPricingError);
    for (const priceCents of [0, -100, 2.5]) expect(() => voucherCharge({ priceCents, quantity: 1, feeMode: 'ADD', fee: FEE })).toThrow(VoucherPricingError);
    expect(() => voucherFeeCents(100, { fixedCents: -1, pctBps: 0 })).toThrow(VoucherPricingError);
  });

  it('margen de KORUM: gestión menos la pasarela sobre lo cobrado', () => {
    // 10 € + 0,65 € = 10,65 €; pasarela 1 % (11 cts) + 9 cts = 20 cts; margen 45 cts.
    expect(voucherFeeMarginCents(1_000, FEE, GATEWAY)).toEqual({ feeCents: 65, gatewayCostCents: 20, marginCents: 45 });
  });
});

describe('QA-VAL01 · tope, validez y aportación «sin producto»', () => {
  it('vales disponibles: el tope menos lo vendido y lo retenido; sin tope, `null`', () => {
    expect(vouchersAvailable(sale({ ticketsSold: 60, ticketsHeld: 15 }))).toBe(25);
    expect(vouchersAvailable(sale({ ticketsSold: 100, ticketsHeld: 0 }))).toBe(0);
    expect(vouchersAvailable(sale({ ticketMax: null, ticketsSold: 5_000 }))).toBeNull();
  });

  it('no se venden vales fuera de venta, con la venta vencida ni pasada su validez', () => {
    expect(voucherSaleBlock(sale(), NOW)).toBeNull();
    expect(voucherSaleBlock(sale({ status: 'BUDGETING' }), NOW)).toBe('NOT_ON_SALE');
    expect(voucherSaleBlock(sale({ closesAt: NOW }), NOW)).toBe('NOT_ON_SALE');
    expect(voucherSaleBlock(sale({ voucherValidUntil: null }), NOW)).toBe('NOT_ON_SALE');
    expect(voucherSaleBlock(sale({ ticketFeeMode: null }), NOW)).toBe('NOT_ON_SALE');
    // La validez la fija la entidad sin mínimo: puede acabar antes que la venta, y entonces la venta se para.
    expect(voucherSaleBlock(sale({ voucherValidUntil: NOW }), NOW)).toBe('VALIDITY_ENDED');
  });

  it('«sin producto» solo con la venta agotada, activada por la entidad y abierta', () => {
    const soldOut = { ticketsSold: 100 };
    expect(noProductOffered(sale(soldOut), NOW)).toBe(true);
    expect(noProductOffered(sale(), NOW)).toBe(false);
    expect(noProductOffered(sale({ ...soldOut, voucherNoProductEnabled: false }), NOW)).toBe(false);
    expect(noProductOffered(sale({ ...soldOut, closesAt: NOW }), NOW)).toBe(false);
    // Sin tope nunca se agota: siempre se compran vales.
    expect(noProductOffered(sale({ ticketMax: null, ticketsSold: 100 }), NOW)).toBe(false);
    // Con los últimos vales retenidos por un pago en curso no se ofrece: si ese pago no se completa, vuelven a estar a la venta.
    expect(vouchersAvailable(sale({ ticketsSold: 98, ticketsHeld: 2 }))).toBe(0);
    expect(noProductOffered(sale({ ticketsSold: 98, ticketsHeld: 2 }), NOW)).toBe(false);
  });

  it('nunca en un colegio con ánimo de lucro (decisión del promotor del 2026-11-19)', () => {
    expect(isForProfitSchool('SCHOOL_OWNER')).toBe(true);
    for (const legalForm of ['PARENTS_ASSOCIATION', 'FOUNDATION', 'SPORTS_ENTITY', 'CULTURAL_ASSOCIATION', 'OTHER_NONPROFIT']) expect(isForProfitSchool(legalForm)).toBe(false);
    expect(noProductOffered(sale({ ticketsSold: 100, legalForm: 'SCHOOL_OWNER' }), NOW)).toBe(false);
  });
});

describe('QA-VAL02 · cuándo se puede gastar un vale', () => {
  const pass = { revokedAt: null, contributionStatus: 'COMPLETED' };
  const valid = { status: 'FUNDRAISING', voucherValidUntil: new Date(NOW.getTime() + DAY) };

  it('se gasta a la venta, cerrada sin liquidar y ya liquidada, hasta su validez', () => {
    for (const status of ['FUNDRAISING', 'GOAL_REACHED', 'CLOSED']) expect(voucherRedeemBlock(pass, { ...valid, status }, NOW)).toBeNull();
    expect(voucherRedeemBlock(pass, { ...valid, voucherValidUntil: NOW }, NOW)).toBe('EXPIRED');
    expect(voucherRedeemBlock(pass, { ...valid, voucherValidUntil: null }, NOW)).toBe('EXPIRED');
  });

  it('no se gasta un pase anulado, sin cobrar o de una venta cancelada o devuelta', () => {
    expect(voucherRedeemBlock({ ...pass, revokedAt: NOW }, valid, NOW)).toBe('REVOKED');
    expect(voucherRedeemBlock({ ...pass, contributionStatus: 'REFUND_PENDING' }, valid, NOW)).toBe('NOT_PAID');
    for (const status of ['REFUNDING', 'REFUNDED', 'CANCELLED', 'BUDGETING']) expect(voucherRedeemBlock(pass, { ...valid, status }, NOW)).toBe('SALE_CLOSED');
  });
});

describe('una venta de vales no es un evento ni una campaña con meta', () => {
  it('no se cancela ni cambia de fecha con las reglas de un evento (llegan en el 5.14c)', () => {
    expect(eventChangeProblem({ format: 'TICKETING', ticketSubtype: 'VOUCHER', status: 'FUNDRAISING', payoutStatus: null })).toBe('NOT_AN_EVENT');
    expect(eventChangeProblem({ format: 'TICKETING', ticketSubtype: 'EVENT', status: 'FUNDRAISING', payoutStatus: null })).toBeNull();
  });

  it('nunca lleva Auto-Impulso (decisión 33, L-023)', () => {
    const initiative = { status: 'FUNDRAISING' as const, goalCents: 20_000, raisedCents: 10_000, closesAt: new Date(NOW.getTime() + DAY) };
    expect(selfBoostRejection({ ...initiative, ticketSubtype: 'VOUCHER' }, 10_000, NOW)).toBe('VOUCHER_SALE');
    expect(selfBoostRejection({ ...initiative, ticketSubtype: 'EVENT' }, 10_000, NOW)).toBeNull();
  });

  it('el BI no le pone 💎 aunque le falte dinero para su «meta»', () => {
    const facts: BiInitiativeFacts = {
      id: 1, walletEscrowId: 'WLT-ESC-1', title: 'Paradita de bisutería', organizationId: 'org', organizationName: 'AMPA', organizationSlug: 'ampa', province: 'Barcelona',
      status: 'FUNDRAISING', format: 'TICKETING', quarter: 'Q4', closesAt: NOW.toISOString(), goalCents: 20_000, raisedCents: 19_000, totalContributions: 10,
      bracketFeeCents: 0, maintFeeCents: 0, gatewayFeeCents: 0, absorbsGatewayCostByKorum: false, realizedGuaranteeCents: 0, projectedGuaranteeAt100Cents: 0,
      approvedSponsorsFeeCents: 0, ticketMarginAt100Cents: 50_000, ticketMarginRealizedCents: 50_000, huchaTopupNetCents: 0,
      settled: { sourcesCents: { bracketFeeCents: 0, supportGuaranteeCents: 0, sponsorFeeCents: 0, digitalTicketFeeCents: 0, maintFeeCents: 0, huchaTopupFeeCents: 0 }, costsCents: 0 }
    };
    expect(buildBiInitiativeRow(facts).isProfitableSelfBoost).toBe(true);
    expect(buildBiInitiativeRow({ ...facts, voucherSale: true }).isProfitableSelfBoost).toBe(false);
  });
});

describe('salud de precios de la tarifa de los vales (motor de reglas globales)', () => {
  const defaults = seed.globalRules as KorumGlobalRulesCents;

  it('con los valores de la semilla la tarifa de los vales cubre la pasarela y no avisa', () => {
    expect(evaluatePricingHealth(defaults).map((alert) => alert.code)).not.toContain('VOUCHER_FEE_BELOW_GATEWAY_COST');
    expect(sampleVoucherMargin(defaults)).toEqual({ grossCents: 1_000, feeCents: 65, gatewayCostCents: 20, marginCents: 45 });
  });

  it('sin gastos de gestión avisa con la peor compra y la cifra que se pierde, y cambia la huella al cambiar la tarifa', () => {
    const losing = { ...defaults, voucherFeeFixedCents: 0, voucherFeeBps: 0 };
    const alert = evaluatePricingHealth(losing).find((item) => item.code === 'VOUCHER_FEE_BELOW_GATEWAY_COST');
    expect(alert).toMatchObject({ severity: 'CRITICAL', params: { amountCents: 500_000, feeCents: 0, gatewayCostCents: 5_009, lossCents: 5_009 }, settingKeys: ['voucherFeeFixedCents', 'voucherFeeBps', 'gatewayPctBps', 'gatewayFixedCents'] });
    const other = evaluatePricingHealth({ ...losing, voucherFeeFixedCents: 1 }).find((item) => item.code === 'VOUCHER_FEE_BELOW_GATEWAY_COST');
    expect(other?.fingerprint).not.toBe(alert?.fingerprint);
  });

  it('también avisa si las compras pequeñas ganan pero las grandes pierden (porcentaje de los vales por debajo del de la pasarela)', () => {
    // 1 € fijo y 0 %: con 50 € gana 40 cts; con 50 vales de 100 € (5.000 €), la pasarela es 50,01 € + 9 cts y pierde 49,10 €.
    const alert = evaluatePricingHealth({ ...defaults, voucherFeeFixedCents: 100, voucherFeeBps: 0 }).find((item) => item.code === 'VOUCHER_FEE_BELOW_GATEWAY_COST');
    expect(alert?.params).toMatchObject({ amountCents: 500_000, feeCents: 100, gatewayCostCents: 5_010, lossCents: 4_910 });
  });

  it('un margen de cero también avisa (Regla 02 §6: debe ser positivo) y nunca lanza con valores raros', () => {
    // 9 cts + 1,02 %: en 1 € la gestión es 10 cts y la pasarela sobre 1,10 €, 1 + 9 = 10 cts. Margen 0 (en las compras grandes, positivo).
    const zero = evaluatePricingHealth({ ...defaults, voucherFeeFixedCents: 9, voucherFeeBps: 102 }).find((item) => item.code === 'VOUCHER_FEE_BELOW_GATEWAY_COST');
    expect(zero?.params).toMatchObject({ amountCents: 100, feeCents: 10, gatewayCostCents: 10, lossCents: 0 });
    expect(() => evaluatePricingHealth({ ...defaults, voucherFeeBps: 50_000 })).not.toThrow();
    expect(evaluatePricingHealth({ ...defaults, voucherFeeFixedCents: -1 }).map((item) => item.code)).toContain('RULE_VALUE_INVALID');
    expect(sampleVoucherMargin({ ...defaults, voucherFeeFixedCents: Number.NaN })).toBeNull();
  });
});
