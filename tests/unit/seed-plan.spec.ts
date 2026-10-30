import { describe, expect, it } from 'vitest';
import { buildPassQrPayload, parsePassQrPayload, signPass, verifyPassSignature } from '@/core/ticketing/qr-signature';
import { planAllFunding, planInitiativeFunding, SEED_NOW, SEED_VAT_BPS, SeedPlanError } from '@/seed/funding-plan';
import { createRandom, seedFromText, splitEuros, uuidFromKey } from '@/seed/random';
import { loadSeedData } from '@/seed/seed-types';

const seed = loadSeedData();

describe('splitEuros · reparto exacto y realista', () => {
  it('suma exactamente el total, respeta el mínimo y es determinista (1.000 casos con semilla fija)', () => {
    const random = createRandom(7);
    for (let i = 0; i < 1_000; i += 1) {
      const count = 1 + Math.floor(random() * 300);
      const total = count * 5 + Math.floor(random() * count * 80);
      const amounts = splitEuros(random, total, count);
      expect(amounts).toHaveLength(count);
      expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(total);
      expect(Math.min(...amounts)).toBeGreaterThanOrEqual(5);
    }
    expect(splitEuros(createRandom(1), 1_000, 20)).toEqual(splitEuros(createRandom(1), 1_000, 20));
  });

  it('rechaza repartos imposibles', () => {
    expect(() => splitEuros(createRandom(1), 40, 10)).toThrow(RangeError);
    expect(() => splitEuros(createRandom(1), 100, 0)).toThrow(RangeError);
  });

  it('uuidFromKey y seedFromText son estables y con formato correcto', () => {
    expect(uuidFromKey('pase-1')).toBe(uuidFromKey('pase-1'));
    expect(uuidFromKey('pase-1')).not.toBe(uuidFromKey('pase-2'));
    expect(uuidFromKey('pase-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(seedFromText('x')).toBe(seedFromText('x'));
  });
});

describe('planInitiativeFunding · los pagos cuadran con la semilla', () => {
  const plans = planAllFunding(seed);

  it('planifica las 8 iniciativas', () => {
    expect(plans.map((plan) => plan.initiativeId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it.each(seed.initiatives.map((initiative) => [initiative.id, initiative.title] as const))('iniciativa %i suma raisedCents y totalContributions: %s', (id) => {
    const initiative = seed.initiatives.find((candidate) => candidate.id === id)!;
    const plan = plans.find((candidate) => candidate.initiativeId === id)!;
    const raised = plan.payments.reduce((sum, payment) => sum + payment.amountCents, 0) + plan.matching.reduce((sum, release) => sum + release.amountCents, 0);
    expect(raised).toBe(initiative.raisedCents);
    expect(plan.payments).toHaveLength(initiative.totalContributions);
  });

  it('la planificación es idéntica en cada ejecución', () => {
    expect(JSON.stringify(planAllFunding(seed))).toBe(JSON.stringify(plans));
  });

  it('las claves de pago son únicas y los pagos están ordenados en el tiempo dentro de la campaña', () => {
    const keys = plans.flatMap((plan) => plan.payments.map((payment) => payment.key));
    expect(new Set(keys).size).toBe(keys.length);
    for (const plan of plans) {
      const initiative = seed.initiatives.find((candidate) => candidate.id === plan.initiativeId)!;
      const times = plan.payments.map((payment) => payment.createdAt.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(Math.max(...times)).toBeLessThanOrEqual(Math.min(new Date(initiative.closesAt).getTime(), SEED_NOW.getTime()));
      expect(Math.min(...times)).toBeLessThan(Math.max(...times));
    }
  });

  it('la iniciativa 1 incluye los 2 patrocinios y la bolsa Matching 2x liberó 150 € sobre las últimas donaciones', () => {
    const plan = plans.find((candidate) => candidate.initiativeId === 1)!;
    expect(plan.payments.filter((payment) => payment.type === 'SPONSORSHIP').map((payment) => payment.sponsorId).sort()).toEqual([2, 4]);
    expect(plan.poolPayins).toHaveLength(1);
    expect(plan.poolPayins[0]).toMatchObject({ sponsorId: 1, poolCents: 25_000, serviceFeeCents: 3_750 });
    expect(plan.matching.reduce((sum, release) => sum + release.amountCents, 0)).toBe(15_000);
    const matched = plan.payments.filter((payment) => payment.matchedBonusCents > 0);
    expect(matched).toHaveLength(plan.matching.length);
    const lastDonation = [...plan.payments].reverse().find((payment) => payment.type === 'DONATION')!;
    expect(lastDonation.matchedBonusCents).toBeGreaterThan(0);
  });

  it('los patrocinios llevan IVA sobre el fee (21 %, provisional) y se cobran enteros: importe + fee + IVA', () => {
    for (const plan of plans) {
      for (const payment of plan.payments.filter((candidate) => candidate.type === 'SPONSORSHIP')) {
        expect(payment.taxCents).toBe(Math.round((payment.serviceFeeCents * SEED_VAT_BPS) / 10_000));
        expect(payment.totalChargedCents).toBe(payment.amountCents + payment.serviceFeeCents + payment.taxCents);
      }
      for (const payment of plan.payments.filter((candidate) => candidate.type !== 'SPONSORSHIP')) expect(payment.taxCents).toBe(0);
    }
    const pool = plans.find((candidate) => candidate.initiativeId === 1)!.poolPayins[0]!;
    expect(pool.serviceFeeCents).toBe(3_750);
    expect(pool.taxCents).toBe(788);
    expect(SEED_VAT_BPS).toBe(2_100);
  });

  it('la bolsa Matching 2x se cobra antes de la primera donación que libera su bonus', () => {
    const plan = plans.find((candidate) => candidate.initiativeId === 1)!;
    const firstMatched = Math.min(...plan.payments.filter((payment) => payment.matchedBonusCents > 0).map((payment) => payment.createdAt.getTime()));
    expect(plan.poolPayins[0]!.paidAt.getTime()).toBeLessThan(firstMatched);
  });

  it('la fiesta (2) vende 196 entradas en 112 compras a 5 € con 0,55 € de gastos de gestión por entrada', () => {
    const plan = plans.find((candidate) => candidate.initiativeId === 2)!;
    expect(plan.payments).toHaveLength(112);
    expect(plan.payments.every((payment) => payment.type === 'TICKET')).toBe(true);
    expect(plan.payments.reduce((sum, payment) => sum + payment.quantity, 0)).toBe(196);
    for (const payment of plan.payments) {
      expect(payment.amountCents).toBe(payment.quantity * 500);
      expect(payment.serviceFeeCents).toBe(payment.quantity * 55);
      expect(payment.totalChargedCents).toBe(payment.quantity * 555);
    }
  });

  it('el cobro de cada pago incluye su aportación voluntaria y su comisión de Paycomet exacta (1 % + 0,09 €)', () => {
    const plan = plans.find((candidate) => candidate.initiativeId === 3)!;
    for (const payment of plan.payments) {
      expect(payment.totalChargedCents).toBe(payment.amountCents + payment.guaranteeCents + payment.serviceFeeCents);
      expect(payment.gatewayFeeCents).toBe(Math.round(payment.totalChargedCents / 100) + 9);
      expect([0, 180]).toContain(payment.guaranteeCents);
    }
    const activation = plan.payments.filter((payment) => payment.guaranteeCents > 0).length / plan.payments.length;
    expect(activation).toBeGreaterThan(0.2);
    expect(activation).toBeLessThan(0.4);
  });

  it('ninguna campaña activa dura más de 60 días ni cobra antes de empezar', () => {
    for (const initiative of seed.initiatives.filter((candidate) => candidate.status === 'FUNDRAISING')) {
      const daysToClose = (new Date(initiative.closesAt).getTime() - SEED_NOW.getTime()) / 86_400_000;
      expect(daysToClose, `iniciativa ${initiative.id}`).toBeLessThanOrEqual(60);
      const plan = plans.find((candidate) => candidate.initiativeId === initiative.id)!;
      expect(plan.firstPayinAt!.getTime()).toBeLessThan(SEED_NOW.getTime());
    }
  });

  it('una iniciativa incoherente falla con un error claro', () => {
    const fractional = structuredClone(seed);
    fractional.initiatives.find((initiative) => initiative.id === 3)!.raisedCents += 50;
    expect(() => planInitiativeFunding(fractional, 3)).toThrow(/euros enteros/);

    const tickets = structuredClone(seed);
    tickets.initiatives.find((initiative) => initiative.id === 2)!.raisedCents += 100;
    expect(() => planInitiativeFunding(tickets, 2)).toThrow(SeedPlanError);

    const tooLong = structuredClone(seed);
    tooLong.initiatives.find((initiative) => initiative.id === 6)!.closesAt = '2027-01-30T23:59:59.000Z';
    expect(() => planInitiativeFunding(tooLong, 6)).toThrow(/no habría tenido tiempo/);

    expect(() => planInitiativeFunding(seed, 99)).toThrow(/no existe/);
  });
});

describe('firma de los pases QR', () => {
  const secret = 'e2e-qr-hmac-secret-0123456789abcdefgh';
  const uuid = uuidFromKey('pase');

  it('firma, construye y verifica un pase', () => {
    const signature = signPass(secret, uuid);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyPassSignature(secret, uuid, signature)).toBe(true);
    expect(buildPassQrPayload(secret, uuid)).toBe(`korum://v1/pass/${uuid}?sig=${signature}`);
    expect(parsePassQrPayload(buildPassQrPayload(secret, uuid))).toEqual({ passUuid: uuid, signature });
  });

  it('un pase alterado, otra clave o una firma de otra longitud no verifican', () => {
    const signature = signPass(secret, uuid);
    expect(verifyPassSignature(secret, uuidFromKey('otro'), signature)).toBe(false);
    expect(verifyPassSignature('otra-clave-secreta-0123456789abcdefgh', uuid, signature)).toBe(false);
    expect(verifyPassSignature(secret, uuid, signature.slice(1))).toBe(false);
    expect(verifyPassSignature(secret, uuid, '')).toBe(false);
  });

  it('rechaza claves cortas y contenidos de QR mal formados', () => {
    expect(() => signPass('corta', uuid)).toThrow(RangeError);
    expect(parsePassQrPayload('https://ejemplo.es/?sig=abc')).toBeNull();
    expect(parsePassQrPayload(`korum://v1/pass/${uuid}?sig=corta`)).toBeNull();
  });
});
