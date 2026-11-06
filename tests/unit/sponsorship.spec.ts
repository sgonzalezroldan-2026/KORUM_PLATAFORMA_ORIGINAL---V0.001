import { describe, expect, it } from 'vitest';
import { isCheckoutOrder } from '@/core/checkout/checkout-rules';
import { sponsorshipPayinLines } from '@/core/finance/payment-journals';
import { validateJournal } from '@/core/finance/ledger-validation';
import {
  calculateSponsorCharge,
  newSponsorshipOrder,
  SPONSOR_FEE_VAT_BPS,
  sponsorLevelOf,
  sponsorshipExpiry,
  sponsorshipInputSchema,
  sponsorshipInvalidField,
  sortSponsorsByLevel
} from '@/core/sponsors/sponsorship-rules';
import { initialSponsorDraft, loadSponsorDraft, saveSponsorDraft, suggestedTier, type SponsorOffer } from '@/components/checkout/sponsor-draft';

/**
 * QA-F05 · Patrocinio de comercios: categoría, fee e IVA encima del importe íntegro, orden del directorio, validación de lo que envía el navegador
 * y asiento del cobro (siempre cuadrado, con el 100 % del nivel a la hucha o a la bolsa Matching 2x).
 */

const TIERS = [10_000, 25_000, 50_000];
const valid = {
  orgSlug: 'cervantes',
  initiativeId: 3,
  locale: 'es',
  method: 'BIZUM',
  tierCents: 25_000,
  matchingPool: false,
  businessName: 'Panadería La Espiga',
  taxId: 'B12345674',
  contactPerson: 'Marta López',
  phone: '600 11 22 33',
  email: 'marta@laespiga.example',
  sector: 'Panadería',
  promo: '10 % en pan',
  promoCode: 'CERVANTES10',
  autoRenew: true
};

describe('categoría del comercio', () => {
  it('el nivel más alto es ORO, el más bajo BRONCE y el del medio PLATA', () => {
    expect(sponsorLevelOf(50_000, TIERS)).toEqual({ level: 'ORO', rank: 3 });
    expect(sponsorLevelOf(25_000, TIERS)).toEqual({ level: 'PLATA', rank: 2 });
    expect(sponsorLevelOf(10_000, TIERS)).toEqual({ level: 'BRONCE', rank: 1 });
  });

  it('no depende del orden en que la entidad guarde los niveles', () => {
    expect(sponsorLevelOf(50_000, [50_000, 10_000, 25_000]).level).toBe('ORO');
    expect(sponsorLevelOf(10_000, [50_000, 10_000, 25_000]).level).toBe('BRONCE');
  });

  it('el directorio va siempre ORO > PLATA > BRONCE y, a igual categoría, el más antiguo primero', () => {
    const sorted = sortSponsorsByLevel([
      { id: 5, tierRank: 1 },
      { id: 4, tierRank: 3 },
      { id: 2, tierRank: 2 },
      { id: 1, tierRank: 3 },
      { id: 3, tierRank: 2 }
    ]);
    expect(sorted.map((sponsor) => sponsor.id)).toEqual([1, 4, 2, 3, 5]);
  });
});

describe('fee e IVA encima del importe íntegro (Regla 02 §5)', () => {
  it('reproduce el ejemplo de la skill de pagos: 250,00 € + 37,50 € de fee + 7,88 € de IVA = 295,38 €', () => {
    expect(calculateSponsorCharge(25_000, 1_500)).toEqual({ amountCents: 25_000, feeCents: 3_750, vatCents: 788, totalChargedCents: 29_538 });
    expect(SPONSOR_FEE_VAT_BPS).toBe(2_100);
  });

  it('el importe del nivel nunca se reduce: el total es siempre importe + fee + IVA, en céntimos enteros', () => {
    for (const amount of TIERS) {
      for (const bps of [0, 500, 1_000, 1_500, 2_500]) {
        const charge = calculateSponsorCharge(amount, bps);
        expect(charge.totalChargedCents).toBe(charge.amountCents + charge.feeCents + charge.vatCents);
        expect(Number.isSafeInteger(charge.totalChargedCents)).toBe(true);
        expect(charge.amountCents).toBe(amount);
      }
    }
  });

  it('sin fee no hay IVA', () => {
    expect(calculateSponsorCharge(10_000, 0)).toEqual({ amountCents: 10_000, feeCents: 0, vatCents: 0, totalChargedCents: 10_000 });
  });
});

describe('validación de lo que envía el navegador', () => {
  it('acepta un patrocinio completo', () => {
    expect(sponsorshipInputSchema.safeParse(valid).success).toBe(true);
  });

  it('acepta la ventaja y el sector vacíos (son opcionales)', () => {
    expect(sponsorshipInputSchema.safeParse({ ...valid, sector: '', promo: '', promoCode: '' }).success).toBe(true);
  });

  it.each([
    [{ email: 'no-es-un-email' }, 'email'],
    [{ phone: 'abc' }, 'phone'],
    [{ taxId: '12' }, 'taxId'],
    [{ tierCents: 0 }, 'tier'],
    [{ businessName: 'A' }, 'form'],
    [{ promoCode: 'con espacios' }, 'form']
  ])('rechaza %j y señala el campo %s', (patch, field) => {
    const raw = { ...valid, ...patch };
    expect(sponsorshipInputSchema.safeParse(raw).success).toBe(false);
    expect(sponsorshipInvalidField(raw)).toBe(field);
  });

  it('no admite métodos de pago ni idiomas desconocidos', () => {
    expect(sponsorshipInputSchema.safeParse({ ...valid, method: 'HUCHA' }).success).toBe(false);
    expect(sponsorshipInputSchema.safeParse({ ...valid, locale: 'fr' }).success).toBe(false);
  });
});

describe('pedido y vigencia', () => {
  it('el pedido de un patrocinio es aleatorio, empieza por KS y es un pedido de checkout válido', () => {
    const orders = new Set(Array.from({ length: 50 }, () => newSponsorshipOrder()));
    expect(orders.size).toBe(50);
    for (const order of orders) {
      expect(order).toMatch(/^KS[0-9A-F]{16}$/);
      expect(isCheckoutOrder(order)).toBe(true);
    }
  });

  it('el distintivo dura doce meses desde el pago', () => {
    expect(sponsorshipExpiry(new Date('2026-11-06T10:00:00Z')).toISOString()).toBe('2027-11-06T10:00:00.000Z');
  });
});

describe('asiento del cobro', () => {
  const scope = { organizationId: 'org-1', initiativeId: 9 };
  const charge = calculateSponsorCharge(25_000, 1_500);

  it('el 100 % del nivel va a la hucha de la iniciativa y el fee y el IVA, a KORUM; el asiento cuadra', () => {
    const lines = sponsorshipPayinLines(scope, { sponsorId: 4, ...charge, toMatchingPool: false });
    expect(lines.map((line) => [line.account, line.direction, line.amountCents])).toEqual([
      ['PSP_CLEARING', 'DEBIT', 29_538],
      ['INITIATIVE_ESCROW', 'CREDIT', 25_000],
      ['KORUM_REVENUE_SPONSOR_FEE', 'CREDIT', 3_750],
      ['TAX_PAYABLE_VAT', 'CREDIT', 788]
    ]);
    expect(() => validateJournal({ ...scope, idempotencyKey: 'test:sponsorship:payin', kind: 'PAYIN_SPONSOR', description: 'Cobro de patrocinio', createdById: 'test', lines })).not.toThrow();
  });

  it('con la bolsa Matching 2x, el importe va a la bolsa del comercio y no a la hucha', () => {
    const lines = sponsorshipPayinLines(scope, { sponsorId: 4, ...charge, toMatchingPool: true });
    expect(lines.find((line) => line.account === 'INITIATIVE_ESCROW')).toBeUndefined();
    expect(lines.find((line) => line.account === 'MATCHING_POOL')).toMatchObject({ direction: 'CREDIT', amountCents: 25_000, sponsorId: 4, initiativeId: 9 });
    expect(() => validateJournal({ ...scope, idempotencyKey: 'test:sponsorship:payin', kind: 'PAYIN_SPONSOR', description: 'Cobro de patrocinio', createdById: 'test', lines })).not.toThrow();
  });
});

describe('borrador del comercio tras un pago rechazado (QA-F10)', () => {
  const offer: SponsorOffer = { tiersCents: TIERS, feeBps: 1_500, matchingAvailable: false };

  it('el nivel sugerido es Plata y la renovación empieza activada', () => {
    expect(suggestedTier(offer)).toBe(25_000);
    expect(initialSponsorDraft(offer)).toMatchObject({ tierCents: 25_000, matchingPool: false, autoRenew: true });
  });

  it('se recupera lo escrito, pero nunca el CIF, un nivel que no existe ni una bolsa ya ocupada', () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'window', { value: { sessionStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) } }, configurable: true });
    try {
      saveSponsorDraft(3, { ...initialSponsorDraft(offer), businessName: 'La Espiga', tierCents: 99_999, matchingPool: true, email: 'marta@laespiga.example' });
      const saved = [...store.values()][0] ?? '';
      expect(saved).not.toMatch(/taxId|B12345674/);
      expect(loadSponsorDraft(3, offer)).toMatchObject({ businessName: 'La Espiga', email: 'marta@laespiga.example', tierCents: 25_000, matchingPool: false });
    } finally {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
