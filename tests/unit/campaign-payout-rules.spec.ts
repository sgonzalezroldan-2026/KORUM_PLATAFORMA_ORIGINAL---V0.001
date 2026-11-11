import { describe, expect, it } from 'vitest';
import {
  beneficiaryDigest,
  CampaignPayoutError,
  invoiceRequired,
  payoutFigures,
  payoutFiguresMatch,
  payoutWindow,
  requestCampaignPayoutSchema,
  validateIban,
  validateProvider
} from '@/core/payouts/campaign-payout-rules';
import { openProviderBeneficiary, sealProviderBeneficiary } from '@/core/payouts/payout-beneficiary-vault';
import { createKeyring } from '@/core/security/crypto';

/** Sprint 4.4a · reglas puras de la liquidación de una campaña: IBAN, cifras al céntimo, petición estricta, huella y cifrado del proveedor. */

const DAY = 86_400_000;
const S = 'secreto-de-prueba-de-las-huellas-0123456789';
const keyring = createKeyring({ version: 1, key: Buffer.alloc(32, 3).toString('base64') });

describe('IBAN del proveedor', () => {
  it('acepta un IBAN válido con espacios o en minúsculas y da sus 4 últimos dígitos', () => {
    expect(validateIban('es91 2100 0418 4502 0005 1332')).toEqual({ valid: true, normalized: 'ES9121000418450200051332', last4: '1332' });
    expect(validateIban('DE89 3704 0044 0532 0130 00')).toMatchObject({ valid: true, last4: '3000' });
  });

  it('rechaza un dígito de control equivocado, un IBAN español corto o letras donde no van', () => {
    expect(validateIban('ES91 2100 0418 4502 0005 1333').valid).toBe(false);
    expect(validateIban('ES91 2100 0418 4502 0005 133').valid).toBe(false);
    expect(validateIban('9121000418450200051332').valid).toBe(false);
    expect(validateIban('').valid).toBe(false);
  });

  it('valida a la vez el CIF/NIF del proveedor y dice qué falla', () => {
    expect(validateProvider({ iban: 'ES9121000418450200051332', providerTaxId: 'b-12345674' })).toEqual({ iban: 'ES9121000418450200051332', taxId: 'B12345674', last4: '1332', bank: '2100' });
    expect(() => validateProvider({ iban: 'ES9121000418450200051333', providerTaxId: 'B12345674' })).toThrow(expect.objectContaining({ reason: 'INVALID_IBAN' }));
    expect(() => validateProvider({ iban: 'ES9121000418450200051332', providerTaxId: 'B12345670' })).toThrow(CampaignPayoutError);
  });
});

describe('cifras de la liquidación al céntimo', () => {
  it('neto = recaudado − (tramo + mantenimiento) − pasarela de la meta; si KORUM absorbe la pasarela, no se descuenta', () => {
    const base = { raisedCents: 583_300, bracketFeeCents: 14_440, maintFeeCents: 0, gatewayFeeCents: 7_860, absorbsGatewayCostByKorum: false };
    expect(payoutFigures(base)).toEqual({ netPaidCents: 561_000, korumFeeSettledCents: 14_440, gatewayInGoalCents: 7_860 });
    expect(payoutFigures({ ...base, absorbsGatewayCostByKorum: true })).toEqual({ netPaidCents: 568_860, korumFeeSettledCents: 14_440, gatewayInGoalCents: 0 });
    // El excedente sobre la meta va íntegro a la entidad.
    expect(payoutFigures({ ...base, raisedCents: 590_000 }).netPaidCents).toBe(567_700);
  });

  it('1.000 casos aleatorios: neto + comisión + pasarela suman exactamente lo recaudado', () => {
    let seed = 44;
    const next = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let i = 0; i < 1_000; i += 1) {
      const input = { raisedCents: 100_000 + next(5_000_000), bracketFeeCents: next(50_000), maintFeeCents: next(5_000), gatewayFeeCents: next(30_000), absorbsGatewayCostByKorum: next(2) === 1 };
      const figures = payoutFigures(input);
      expect(figures.netPaidCents + figures.korumFeeSettledCents + figures.gatewayInGoalCents).toBe(input.raisedCents);
      expect(Number.isSafeInteger(figures.netPaidCents)).toBe(true);
    }
  });

  it('un cobro o un contracargo posterior descuadran lo pedido', () => {
    const initiative = { raisedCents: 3_000, bracketFeeCents: 200, maintFeeCents: 0, gatewayFeeCents: 100, absorbsGatewayCostByKorum: false };
    expect(payoutFiguresMatch({ netPaidCents: 2_700, korumFeeSettledCents: 200 }, initiative)).toBe(true);
    expect(payoutFiguresMatch({ netPaidCents: 2_700, korumFeeSettledCents: 200 }, { ...initiative, raisedCents: 3_500 })).toBe(false);
    expect(payoutFiguresMatch({ netPaidCents: 2_700, korumFeeSettledCents: 200 }, { ...initiative, raisedCents: 2_000 })).toBe(false);
  });

  it('la factura es obligatoria en una campaña de presupuesto, no en una taquilla', () => {
    expect(invoiceRequired('BUDGET')).toBe(true);
    expect(invoiceRequired('TICKETING')).toBe(false);
  });

  it('la ventana de 90 días se cuenta desde el primer cobro y no baja de 0', () => {
    const first = new Date('2026-09-01T10:00:00Z');
    expect(payoutWindow(first, new Date(first.getTime() + 75 * DAY + 3_600_000))).toEqual({ deadline: new Date(first.getTime() + 90 * DAY), daysLeft: 14 });
    expect(payoutWindow(first, new Date(first.getTime() + 120 * DAY))?.daysLeft).toBe(0);
    expect(payoutWindow(null, first)).toBeNull();
  });
});

describe('petición de la liquidación', () => {
  it('es estricta: un destino conocido, sin campos de más, y la factura obligatoria si se paga al proveedor', () => {
    expect(requestCampaignPayoutSchema.safeParse({ destination: 'ORGANIZATION', initiativeId: 3, invoiceFileId: null }).success).toBe(true);
    expect(requestCampaignPayoutSchema.safeParse({ destination: 'ORGANIZATION', initiativeId: 3, invoiceFileId: null, netPaidCents: 1 }).success).toBe(false);
    expect(requestCampaignPayoutSchema.safeParse({ destination: 'BANK', initiativeId: 3, invoiceFileId: null }).success).toBe(false);
    expect(requestCampaignPayoutSchema.safeParse({ destination: 'PROVIDER', initiativeId: 3, invoiceFileId: null, providerName: 'Toldos', providerTaxId: 'B12345674', iban: 'ES9121000418450200051332' }).success).toBe(false);
    expect(requestCampaignPayoutSchema.safeParse({ destination: 'ORGANIZATION', initiativeId: 0, invoiceFileId: null }).success).toBe(false);
  });

  it('limpia el nombre del proveedor: sin caracteres de control ni de dirección de texto, y con límites', () => {
    const parsed = requestCampaignPayoutSchema.parse({ destination: 'PROVIDER', initiativeId: 3, invoiceFileId: 'cm3abcdefghijklmnopqrstuv', providerName: '  Toldos‮   del\u0007 Sur  ', providerTaxId: 'B12345674', iban: 'ES9121000418450200051332' });
    expect(parsed.destination === 'PROVIDER' ? parsed.providerName : '').toBe('Toldos del Sur');
    expect(requestCampaignPayoutSchema.safeParse({ destination: 'PROVIDER', initiativeId: 3, invoiceFileId: 'cm3abcdefghijklmnopqrstuv', providerName: 'X', providerTaxId: 'B12345674', iban: 'ES9121000418450200051332' }).success).toBe(false);
  });
});

describe('IBAN y CIF del proveedor: huella y cifrado', () => {
  it('la huella es estable y cambia con cualquier dígito; el cifrado está atado a su iniciativa', () => {
    const provider = { iban: 'ES9121000418450200051332', taxId: 'B12345674' };
    expect(beneficiaryDigest(S, provider)).toBe(beneficiaryDigest(S, provider));
    expect(beneficiaryDigest(S, { ...provider, iban: 'ES7921000813610123456789' })).not.toBe(beneficiaryDigest(S, provider));
    expect(beneficiaryDigest('otro-secreto-de-mas-de-treinta-y-dos-caracteres', provider)).not.toBe(beneficiaryDigest(S, provider));

    const sealed = sealProviderBeneficiary(keyring, 12, provider);
    expect(JSON.stringify(sealed)).not.toContain('2100');
    expect(openProviderBeneficiary(keyring, { initiativeId: 12, ...sealed })).toEqual(provider);
    // Copiado a otra liquidación (otra iniciativa), no se puede descifrar.
    expect(() => openProviderBeneficiary(keyring, { initiativeId: 13, ...sealed })).toThrow();
  });
});
