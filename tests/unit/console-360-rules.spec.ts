import { describe, expect, it } from 'vitest';
import { categorySchema, ley49Outcome, kybReviewSchema, noteHasPersonalData, pickTariffValues, shiftedExemptRemaining, tariffSchema, TARIFF_LIMITS } from '@/core/admin/org-360-rules';
import { validateJournal } from '@/core/finance/ledger-validation';
import { selfBoostLines } from '@/core/finance/payment-journals';
import { fixHasEffect, missingToGoal, planNegativeReturnFix, selfBoostOrder, selfBoostRejection } from '@/core/finance/self-boost';

/**
 * Sprint 5.2 · reglas puras del Auto-Impulso, de la corrección de tarifas y de la ficha 360º (QA-A02, QA-A03). Las pruebas de integración cubren lo que
 * pasa en la base de datos; aquí se fijan las decisiones: qué se rechaza, qué cuadra y qué no se toca de lo ya prometido.
 */

const NOW = new Date('2026-11-12T10:00:00Z');
const OPEN = { status: 'FUNDRAISING' as const, goalCents: 100_000, raisedCents: 85_000, closesAt: new Date('2026-12-01T10:00:00Z') };

describe('QA-A02 · Auto-Impulso: cuándo se puede aportar', () => {
  it('con la campaña recaudando, dentro de plazo y la cifra que la persona vio, se puede', () => {
    expect(missingToGoal(100_000, 85_000)).toBe(15_000);
    expect(selfBoostRejection(OPEN, 15_000, NOW)).toBeNull();
  });

  it('si la cifra cambió (otra aportación entre medias) no se gasta más de lo que se vio', () => {
    expect(selfBoostRejection({ ...OPEN, raisedCents: 90_000 }, 15_000, NOW)).toBe('AMOUNT_CHANGED');
  });

  it.each(['BUDGETING', 'GOAL_REACHED', 'CLOSED', 'EXPIRED', 'RESIZE_VOTING', 'REFUNDING', 'REFUNDED', 'CANCELLED'] as const)('una campaña en %s no recibe Auto-Impulso', (status) => {
    expect(selfBoostRejection({ ...OPEN, status }, 15_000, NOW)).toBe('NOT_FUNDRAISING');
  });

  it('pasada su fecha límite tampoco: la cierra la tarea de vencimiento, no un Auto-Impulso', () => {
    expect(selfBoostRejection({ ...OPEN, closesAt: new Date('2026-11-12T09:59:59Z') }, 15_000, NOW)).toBe('PAST_DEADLINE');
    expect(selfBoostRejection({ ...OPEN, closesAt: NOW }, 15_000, NOW)).toBe('PAST_DEADLINE');
  });

  it('con la meta cubierta (o pasada) no hay nada que aportar, y lo que falta nunca es negativo', () => {
    expect(selfBoostRejection({ ...OPEN, raisedCents: 100_000 }, 1, NOW)).toBe('NOTHING_MISSING');
    expect(missingToGoal(100_000, 130_000)).toBe(0);
  });

  it('el asiento cuadra al céntimo, es del gasto de KORUM a la hucha de la iniciativa y no toca la pasarela', () => {
    const lines = selfBoostLines({ organizationId: 'CERVANTES', initiativeId: 1 }, 15_000);
    expect(lines).toEqual([
      { account: 'AUTO_BOOST_EXPENSE', direction: 'DEBIT', amountCents: 15_000, organizationId: 'CERVANTES' },
      { account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents: 15_000, organizationId: 'CERVANTES', initiativeId: 1 }
    ]);
    expect(lines.some((line) => line.account === 'PSP_CLEARING' || line.account === 'GATEWAY_FEES_EXPENSE')).toBe(false);
    expect(() =>
      validateJournal({ idempotencyKey: 'selfboost:KB-1-1', kind: 'SELF_BOOST_INJECTION', description: 'Auto-Impulso', organizationId: 'CERVANTES', initiativeId: 1, lines })
    ).not.toThrow();
  });

  it('cada Auto-Impulso de una iniciativa lleva su propia referencia (un contracargo puede reabrirla)', () => {
    expect(selfBoostOrder(7, 1)).toBe('KB-7-1');
    expect(selfBoostOrder(7, 2)).not.toBe(selfBoostOrder(7, 1));
  });
});

describe('QA-A02 · «Corregir tarifas en 1 clic»: solo lo que no se ha prometido (decisión del promotor, 2026-11-11)', () => {
  const global = { fullIntegrityCheckCents: 180, ticketFeeFixedCents: 45, ticketFeeBps: 200 };
  const own = { customRules: true, fullIntegrityCheckCents: 0, ticketFeeFixedCents: 10, ticketFeeBps: 300, hasPublishedTicketing: false };

  it('sube a los valores globales solo las tarifas propias que están por debajo', () => {
    const plan = planNegativeReturnFix({ status: 'FUNDRAISING', absorbsGatewayCostByKorum: false }, own, global);
    expect(plan.organization).toEqual({ fullIntegrityCheckCents: 180, ticketFeeFixedCents: 45 });
    expect(fixHasEffect(plan)).toBe(true);
  });

  it('con una taquilla o rifa a la venta no se tocan los gastos de gestión de las entradas (la compra lee la tarifa actual): cambiarían lo prometido', () => {
    const plan = planNegativeReturnFix({ status: 'FUNDRAISING', absorbsGatewayCostByKorum: false }, { ...own, hasPublishedTicketing: true }, global);
    // La garantía sugerida sí sube; los gastos de gestión fijos y variables se quedan como están y la pantalla lo explica.
    expect(plan.organization).toEqual({ fullIntegrityCheckCents: 180 });
    expect(plan.publishedLeftUntouched).toBe(true);
    const onlyTickets = planNegativeReturnFix({ status: 'FUNDRAISING', absorbsGatewayCostByKorum: false }, { ...own, fullIntegrityCheckCents: 180, hasPublishedTicketing: true }, global);
    expect(onlyTickets.organization).toEqual({});
    expect(fixHasEffect(onlyTickets)).toBe(false);
  });

  it('una entidad con las tarifas globales no cambia, aunque la campaña pierda dinero', () => {
    const plan = planNegativeReturnFix({ status: 'FUNDRAISING', absorbsGatewayCostByKorum: false }, { ...own, customRules: false }, global);
    expect(plan.organization).toEqual({});
    expect(fixHasEffect(plan)).toBe(false);
  });

  it('la cobertura de pasarela de un borrador tampoco se retira desde este botón (el BI no incluye borradores)', () => {
    const draft = planNegativeReturnFix({ status: 'BUDGETING', absorbsGatewayCostByKorum: true }, { ...own, customRules: false }, global);
    expect(draft).toMatchObject({ publishedLeftUntouched: false });
    expect(fixHasEffect(draft)).toBe(false);
  });

  it.each(['FUNDRAISING', 'GOAL_REACHED', 'CLOSED', 'EXPIRED'] as const)('una campaña %s con cobertura de pasarela NO se toca: la entidad recibe lo que se le enseñó', (status) => {
    const plan = planNegativeReturnFix({ status, absorbsGatewayCostByKorum: true }, { ...own, customRules: false }, global);
    expect(plan).toMatchObject({ publishedLeftUntouched: true });
    expect(fixHasEffect(plan)).toBe(false);
  });
});

describe('QA-A03 · tarifas individuales: Zod rechaza lo imposible, nunca lo «poco rentable»', () => {
  const valid = {
    customRules: true as const,
    exemptLimitCents: 100_000,
    t1Bps: 500,
    t2Bps: 400,
    t3Bps: 300,
    sponsorFeeBps: 1_500,
    fullIntegrityCheckCents: 180,
    ticketFeeFixedCents: 45,
    ticketFeeBps: 200,
    maintActive: false,
    maintPerInitCents: 4_900,
    maintAnnualCapCents: 14_700
  };

  it('acepta una tarifa válida y la de «valores globales» sin campos', () => {
    expect(tariffSchema.safeParse(valid).success).toBe(true);
    expect(tariffSchema.safeParse({ customRules: false }).success).toBe(true);
  });

  it('acepta tarifas que pierden dinero: eso lo avisa la salud de precios, no bloquea el guardado', () => {
    expect(tariffSchema.safeParse({ ...valid, ticketFeeFixedCents: 0, ticketFeeBps: 0, fullIntegrityCheckCents: 0, t1Bps: 0, t2Bps: 0, t3Bps: 0, sponsorFeeBps: 0 }).success).toBe(true);
  });

  it.each([
    ['decimales', { t1Bps: 5.5 }],
    ['negativos', { exemptLimitCents: -1 }],
    ['texto en vez de número', { ticketFeeFixedCents: '45' }],
    ['no numéricos', { maintPerInitCents: Number.NaN }],
    ['infinitos', { maintAnnualCapCents: Number.POSITIVE_INFINITY }],
    ['más del 100 %', { sponsorFeeBps: 10_001 }],
    ['por encima del tope de mantenimiento por iniciativa', { maintPerInitCents: TARIFF_LIMITS.maintPerInitCents + 1 }],
    ['por encima del tope anual de mantenimiento', { maintAnnualCapCents: TARIFF_LIMITS.maintAnnualCapCents + 1 }],
    ['nulos', { t2Bps: null }]
  ])('rechaza valores %s', (_name, patch) => {
    expect(tariffSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('rechaza campos que faltan y campos que no existen', () => {
    const { t3Bps: _omitted, ...missing } = valid;
    expect(tariffSchema.safeParse(missing).success).toBe(false);
    expect(tariffSchema.safeParse({ ...valid, unknown: 1 }).success).toBe(false);
    expect(tariffSchema.safeParse({ customRules: false, t1Bps: 1 }).success).toBe(false);
  });

  it('copia solo los once campos de la tarifa', () => {
    const picked = pickTariffValues({ ...valid, extra: 'no' } as never);
    expect(Object.keys(picked).sort()).toEqual(['exemptLimitCents', 'fullIntegrityCheckCents', 'maintActive', 'maintAnnualCapCents', 'maintPerInitCents', 'sponsorFeeBps', 't1Bps', 't2Bps', 't3Bps', 'ticketFeeBps', 'ticketFeeFixedCents']);
  });

  it('cambiar el límite exento mueve el cupo restante lo mismo: lo gastado no cambia y nunca pasa del límite ni baja de 0', () => {
    // Límite 1.000 €, quedan 400 € (gastados 600 €).
    expect(shiftedExemptRemaining(100_000, 150_000, 40_000)).toBe(90_000);
    expect(shiftedExemptRemaining(100_000, 70_000, 40_000)).toBe(10_000);
    // Un límite por debajo de lo ya gastado (60.000) se rechaza: recortarlo a 0 perdería lo gastado y, al volver a subirlo, el cupo reaparecería.
    expect(shiftedExemptRemaining(100_000, 50_000, 40_000)).toBeNull();
    expect(shiftedExemptRemaining(100_000, 60_000, 40_000)).toBe(0);
    expect(shiftedExemptRemaining(100_000, 100_000, 100_000)).toBe(100_000);
    expect(shiftedExemptRemaining(100_000, 0, 100_000)).toBe(0);
    // Bajar y volver a subir nunca da más cupo del que había.
    const down = shiftedExemptRemaining(100_000, 70_000, 30_000)!;
    expect(shiftedExemptRemaining(70_000, 100_000, down)).toBe(30_000);
  });
});

describe('QA-A03 · revisión del KYB y categorías', () => {
  it('verificar no necesita nota; devolver exige una de 10 a 600 caracteres', () => {
    expect(kybReviewSchema.safeParse({ decision: 'VERIFIED', ley49Accredited: false }).success).toBe(true);
    expect(kybReviewSchema.safeParse({ decision: 'VERIFIED', ley49Accredited: true, paycometSplitId: 'mock-split-cole' }).success).toBe(true);
    expect(kybReviewSchema.safeParse({ decision: 'REJECTED', note: 'Falta la firma en el acta', releaseCif: false }).success).toBe(true);
    expect(kybReviewSchema.safeParse({ decision: 'REJECTED', note: 'corto', releaseCif: false }).success).toBe(false);
    expect(kybReviewSchema.safeParse({ decision: 'REJECTED', note: 'x'.repeat(601), releaseCif: false }).success).toBe(false);
    expect(kybReviewSchema.safeParse({ decision: 'MAYBE', note: 'Falta la firma en el acta' }).success).toBe(false);
    expect(kybReviewSchema.safeParse({ decision: 'VERIFIED', ley49Accredited: true, paycometSplitId: 'con espacios y ;' }).success).toBe(false);
  });

  it.each([
    ['un email', 'Escribid a marta.gil@gmail.com con el acta'],
    ['un IBAN', 'El certificado dice ES91 2100 0418 4502 0005 1332 pero no coincide'],
    ['un DNI', 'El DNI 12345678Z está caducado, subid otro'],
    ['una serie de cifras', 'Llamad al 600 123 456 para aclararlo'],
    ['un NIE', 'El NIE X1234567L no se lee bien']
  ])('la nota con %s se rechaza (la leen las dos personas que firman)', (_name, note) => {
    expect(noteHasPersonalData(note)).toBe(true);
    expect(kybReviewSchema.safeParse({ decision: 'REJECTED', note, releaseCif: false }).success).toBe(false);
  });

  it('una nota normal pasa, con cifras sueltas como «página 2» o «4 documentos»', () => {
    expect(noteHasPersonalData('Falta la página 2 del acta y los 4 documentos van sin firma')).toBe(false);
    // Una fecha o un año no son un dato personal (8 cifras como máximo).
    expect(noteHasPersonalData('El acta del 12-05-2024 está caducada: subid la de 2026')).toBe(false);
  });

  it('la nota se limpia de caracteres de control y de dirección del texto', () => {
    const parsed = kybReviewSchema.parse({ decision: 'REJECTED', note: 'Falta‮ la\u0000 firma   del acta', releaseCif: true });
    expect(parsed).toMatchObject({ note: 'Falta la firma del acta', releaseCif: true });
  });

  it('qué se dice de la Ley 49/2002 al verificar', () => {
    expect(ley49Outcome(false, false)).toBe('NOT_DECLARED');
    expect(ley49Outcome(false, true)).toBe('NOT_DECLARED');
    expect(ley49Outcome(true, true)).toBe('VERIFIED');
    expect(ley49Outcome(true, false)).toBe('NOT_ACCREDITED');
  });

  it('una categoría nueva se limpia y exige nombre; el icono por defecto es 🌟', () => {
    expect(categorySchema.parse({ name: '  Huerto   escolar ', rule: 'EXEMPT' })).toEqual({ name: 'Huerto escolar', icon: '🌟', rule: 'EXEMPT' });
    expect(categorySchema.safeParse({ name: 'a', rule: 'EXEMPT' }).success).toBe(false);
    expect(categorySchema.safeParse({ name: 'Huerto', rule: 'OTRA' }).success).toBe(false);
  });
});
