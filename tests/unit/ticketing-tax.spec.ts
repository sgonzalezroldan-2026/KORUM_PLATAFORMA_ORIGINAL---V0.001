import { describe, expect, it } from 'vitest';
import { buildDonationDocument, donationDocumentKind } from '@/core/tax/donation-document';
import { buildModel182File, deductionPercent, declaredNature, isRecurrentDonor, Model182FormatError, normalizeText, RECORD_LENGTH, type Model182Declarant } from '@/core/tax/model182-format';
import { validateTaxId } from '@/core/tax/tax-id';
import { generateGatePin, hashGatePin, verifyGatePin } from '@/core/ticketing/gate-pin';
import { canonicalEntries, hashAct, hashEntries, pickWinners, verifyDrawAct, type DrawAct } from '@/core/ticketing/raffle-draw';
import { lowestFreeNumbers } from '@/core/ticketing/ticket-issuance';
import { computeVerifactuHash, formatCents, generatedAtOf, hashInput, issueDateOf, verifactuQrUrl } from '@/services/invoicing/verifactu-record';

const SECRET = 'secreto-de-pruebas-del-pin-de-porteria-0123456789';

describe('QA-REG03 · validación oficial de NIF, NIE y CIF', () => {
  it.each(['12345678Z', '12345678-z', ' 00000000T ', 'X1234567L', 'Y1234567X', 'Z1234567R', 'B12345674', 'G12345674', 'G1234567D', 'P1234567D'])('acepta %s', (id) => {
    expect(validateTaxId(id).valid).toBe(true);
  });
  it.each(['12345678A', 'X1234567A', 'B12345670', 'B1234567D', 'P12345674', '1234567Z', '', 'ABCDEFGHI', 'I12345674'])('rechaza %s', (id) => {
    expect(validateTaxId(id).valid).toBe(false);
  });
  it('normaliza y distingue el tipo', () => {
    expect(validateTaxId('12345678-z')).toEqual({ valid: true, normalized: '12345678Z', kind: 'DNI' });
    expect(validateTaxId('x1234567l')).toEqual({ valid: true, normalized: 'X1234567L', kind: 'NIE' });
    expect(validateTaxId('G-12345674')).toEqual({ valid: true, normalized: 'G12345674', kind: 'CIF' });
  });
});

describe('Huella de Veri*factu con los ejemplos oficiales de la AEAT (especificaciones v0.1.2)', () => {
  const first = { issuerTaxId: '89890001K', invoiceNumber: '12345678/G33', issueDate: '01-01-2024', invoiceType: 'F1', taxTotal: '12.35', amountTotal: '123.45', previousHash: null, generatedAt: '2024-01-01T19:20:30+01:00' };

  it('caso 1: primer registro, con `Huella=` vacía', () => {
    expect(hashInput(first)).toBe('IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00');
    expect(computeVerifactuHash(first)).toBe('3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60');
  });

  it('caso 2: encadena con la huella del registro anterior', () => {
    const second = { ...first, invoiceNumber: '12345679/G34', previousHash: computeVerifactuHash(first), generatedAt: '2024-01-01T19:20:35+01:00' };
    expect(computeVerifactuHash(second)).toBe('F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97');
  });

  it('las fechas van en hora de Madrid, con su huso', () => {
    expect(issueDateOf(new Date('2026-12-31T23:30:00Z'))).toBe('01-01-2027');
    expect(generatedAtOf(new Date('2026-01-15T10:00:00Z'))).toBe('2026-01-15T11:00:00+01:00');
    expect(generatedAtOf(new Date('2026-07-15T10:00:00Z'))).toBe('2026-07-15T12:00:00+02:00');
  });

  it('importes con punto decimal y URL del QR codificada', () => {
    expect(formatCents(12345)).toBe('123.45');
    expect(formatCents(5)).toBe('0.05');
    expect(verifactuQrUrl({ issuerTaxId: 'B12345674', invoiceNumber: 'FAC-2026-0001', issueDate: '01-02-2026', amountTotal: '45.38' })).toBe('https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345674&numserie=FAC-2026-0001&fecha=01-02-2026&importe=45.38');
  });
});

describe('QA-REG02 · formato de longitud fija del Modelo 182', () => {
  const declarant: Model182Declarant = { taxId: 'G12345674', legalName: 'Fundación Ñandú Cervantes', contactPhone: '934000000', contactName: 'García Pérez, Ana', fiscalYear: 2026, declarationNumber: '1822026000001' };
  const donors = [
    { taxId: '12345678Z', kind: 'DNI' as const, fullName: 'Núñez Peña, Íñigo', provinceCode: '08', amountCents: 30_050, previousYearsCents: [0, 10_000, 10_000] as const },
    { taxId: 'B12345674', kind: 'CIF' as const, fullName: 'Comercio del Barrio SL', provinceCode: '28', amountCents: 5_000, previousYearsCents: [0, 0, 0] as const }
  ];
  /** Las posiciones del diseño empiezan en 1. */
  const field = (record: string, from: number, to: number) => record.slice(from - 1, to);

  const file = buildModel182File(declarant, donors);
  const [header, first, second] = file.content.split('\r\n') as [string, string, string];

  it('cada registro mide exactamente 250, también en bytes con Ñ', () => {
    for (const record of [header, first, second]) expect(record).toHaveLength(RECORD_LENGTH);
    expect(file.bytes.length).toBe(3 * (RECORD_LENGTH + 2));
    expect(file.bytes.toString('latin1')).toBe(file.content);
  });

  it('registro de declarante en sus posiciones', () => {
    expect(field(header, 1, 1)).toBe('1');
    expect(field(header, 2, 4)).toBe('182');
    expect(field(header, 5, 8)).toBe('2026');
    expect(field(header, 9, 17)).toBe('G12345674');
    expect(field(header, 18, 57).trimEnd()).toBe('FUNDACION ÑANDU CERVANTES');
    expect(field(header, 58, 58)).toBe('T');
    expect(field(header, 59, 67)).toBe('934000000');
    expect(field(header, 68, 107).trimEnd()).toBe('GARCIA PEREZ ANA');
    expect(field(header, 108, 120)).toBe('1822026000001');
    expect(field(header, 123, 135)).toBe('0000000000000');
    expect(field(header, 136, 144)).toBe('000000002');
    expect(field(header, 145, 159)).toBe('000000000035050');
    expect(field(header, 160, 160)).toBe('1');
  });

  it('registro de declarado en sus posiciones', () => {
    expect(field(first, 1, 8)).toBe('21822026');
    expect(field(first, 9, 17)).toBe('G12345674');
    expect(field(first, 18, 26)).toBe('12345678Z');
    expect(field(first, 27, 35).trim()).toBe('');
    expect(field(first, 36, 75).trimEnd()).toBe('NUÑEZ PEÑA IÑIGO');
    expect(field(first, 76, 77)).toBe('08');
    expect(field(first, 78, 78)).toBe('A');
    expect(field(first, 79, 83)).toBe('04500');
    expect(field(first, 84, 96)).toBe('0000000030050');
    expect(field(first, 105, 105)).toBe('F');
    expect(field(first, 107, 110)).toBe('0000');
    expect(field(first, 132, 132)).toBe('1');
    expect(field(second, 79, 83)).toBe('04000');
    expect(field(second, 105, 105)).toBe('J');
    expect(field(second, 132, 132)).toBe('2');
  });

  it('el total del declarante es la suma exacta de los declarados', () => {
    expect(file.totalCents).toBe(35_050);
    expect(file.donorCount).toBe(2);
  });

  it('recurrencia: dos ejercicios anteriores, cada uno igual o superior al anterior', () => {
    expect(isRecurrentDonor([0, 100, 100])).toBe(true);
    expect(isRecurrentDonor([100, 100, 200])).toBe(true);
    expect(isRecurrentDonor([0, 200, 100])).toBe(false);
    expect(isRecurrentDonor([300, 200, 200])).toBe(false);
    expect(isRecurrentDonor([100, 0, 100])).toBe(false);
    expect(isRecurrentDonor([0, 0, 100])).toBe(false);
  });

  it('porcentajes vigentes', () => {
    expect(deductionPercent('F', 25_000, true)).toBe(8_000);
    expect(deductionPercent('F', 25_001, false)).toBe(4_000);
    expect(deductionPercent('F', 25_001, true)).toBe(4_500);
    expect(deductionPercent('J', 100, false)).toBe(4_000);
    expect(deductionPercent('J', 100, true)).toBe(5_000);
    expect(deductionPercent('E', 100, false)).toBe(8_000);
  });

  it('naturaleza del declarado', () => {
    expect(declaredNature('X1234567L', 'NIE')).toBe('F');
    expect(declaredNature('B12345674', 'CIF')).toBe('J');
    expect(declaredNature('E12345674', 'CIF')).toBe('E');
  });

  it('texto en mayúsculas, sin acentos, conservando Ñ y Ç', () => {
    expect(normalizeText('  Peña-Çelà, José  M.ª ')).toBe('PEÑA ÇELA JOSE M');
  });

  it('rechaza datos que romperían el fichero', () => {
    expect(() => buildModel182File({ ...declarant, taxId: 'G12345670' }, [])).toThrow(Model182FormatError);
    expect(() => buildModel182File({ ...declarant, contactPhone: '93' }, [])).toThrow(Model182FormatError);
    expect(() => buildModel182File({ ...declarant, fiscalYear: 2021 }, [])).toThrow(Model182FormatError);
    expect(() => buildModel182File({ ...declarant, declarationNumber: '1' }, [])).toThrow(Model182FormatError);
    expect(() => buildModel182File(declarant, [{ ...donors[0]!, provinceCode: '77' }])).toThrow(Model182FormatError);
    expect(() => buildModel182File(declarant, [{ ...donors[0]!, amountCents: 0 }])).toThrow(Model182FormatError);
  });
});

describe('Certificado o justificante', () => {
  const verified = { legalName: 'Fundación', cif: 'G12345674', ley49: true, ley49VerifiedAt: new Date('2026-01-01') };
  const donation = { id: 7, type: 'DONATION', status: 'COMPLETED', refundedCents: 0, amountCents: 2_500, fiscalYear: 2026, createdAt: new Date('2026-03-01'), donorFullName: 'Ana', donorTaxIdHmac: 'hmac' };

  it('certificado solo con Ley 49/2002 verificada y NIF', () => {
    expect(donationDocumentKind(verified, donation)).toBe('TAX_CERTIFICATE');
    expect(donationDocumentKind({ ...verified, ley49VerifiedAt: null }, donation)).toBe('NOMINATIVE_RECEIPT');
    expect(donationDocumentKind({ ...verified, ley49: false }, donation)).toBe('NOMINATIVE_RECEIPT');
    expect(donationDocumentKind(verified, { donorTaxIdHmac: null, donorFullName: 'Ana' })).toBe('NOMINATIVE_RECEIPT');
    expect(donationDocumentKind(verified, { donorTaxIdHmac: 'hmac', donorFullName: null })).toBe('NOMINATIVE_RECEIPT');
  });

  it('solo para donaciones completadas y sin reembolso', () => {
    expect(buildDonationDocument(verified, donation)).toMatchObject({ kind: 'TAX_CERTIFICATE', amountCents: 2_500, reference: 'DON-2026-000007' });
    for (const change of [{ type: 'TICKET' }, { status: 'REFUNDED' }, { refundedCents: 100 }]) expect(() => buildDonationDocument(verified, { ...donation, ...change })).toThrow();
  });
});

describe('PIN de portería', () => {
  it('siempre seis dígitos', () => {
    for (let index = 0; index < 50; index += 1) expect(generateGatePin()).toMatch(/^\d{6}$/);
  });
  it('hash lento, con sal, que no contiene el PIN', async () => {
    const [a, b] = await Promise.all([hashGatePin(SECRET, '123456'), hashGatePin(SECRET, '123456')]);
    expect(a).not.toBe(b);
    expect(a).not.toContain('123456');
    expect(a.startsWith('scrypt$32768$')).toBe(true);
    expect(await verifyGatePin(SECRET, '123456', a)).toBe(true);
    expect(await verifyGatePin(SECRET, '123457', a)).toBe(false);
  });
  it('sin el secreto, el hash no sirve', async () => {
    const stored = await hashGatePin(SECRET, '123456');
    expect(await verifyGatePin('otro-secreto-distinto-de-pruebas-0123456789', '123456', stored)).toBe(false);
  });
  it('un hash mal formado nunca da acceso', async () => {
    expect(await verifyGatePin(SECRET, '123456', 'basura')).toBe(false);
    expect(await verifyGatePin(SECRET, '123456', '')).toBe(false);
  });
});

describe('Sorteo certificado', () => {
  const entries = [3, 1, 2, 5, 4].map((number) => ({ number, serialCode: `RIFA-2026-00000${number}` }));

  it('ganadores distintos, siempre de la lista', () => {
    for (let run = 0; run < 200; run += 1) {
      const winners = pickWinners([1, 2, 3, 4, 5], 3);
      expect(new Set(winners).size).toBe(3);
      for (const winner of winners) expect([1, 2, 3, 4, 5]).toContain(winner);
    }
  });

  it('todas las papeletas pueden ganar, con la misma probabilidad', () => {
    const counts = new Map<number, number>();
    for (let run = 0; run < 6_000; run += 1) {
      const [winner] = pickWinners([1, 2, 3], 1);
      counts.set(winner!, (counts.get(winner!) ?? 0) + 1);
    }
    for (const number of [1, 2, 3]) {
      expect(counts.get(number)).toBeGreaterThan(1_700);
      expect(counts.get(number)).toBeLessThan(2_300);
    }
  });

  it('rechaza más premios que papeletas', () => {
    expect(() => pickWinners([1], 2)).toThrow(RangeError);
    expect(() => pickWinners([1], 0)).toThrow(RangeError);
  });

  it('la huella no depende del orden de lectura', () => {
    expect(hashEntries(entries)).toBe(hashEntries([...entries].reverse()));
    expect(canonicalEntries(entries).map((entry) => entry.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('un acta retocada no pasa la comprobación', () => {
    const act: DrawAct = { initiativeId: 1, round: 1, drawnAt: '2026-05-01T10:00:00.000Z', participantsSha256: hashEntries(entries), participantCount: 5, winningNumbers: [3] };
    const sha = hashAct(act);
    expect(verifyDrawAct(act, entries, sha)).toBe(true);
    expect(verifyDrawAct({ ...act, winningNumbers: [4] }, entries, sha)).toBe(false);
    expect(verifyDrawAct(act, entries.slice(1), sha)).toBe(false);
    expect(verifyDrawAct({ ...act, winningNumbers: [99] }, entries, hashAct({ ...act, winningNumbers: [99] }))).toBe(false);
  });
});

describe('Numeración de rifas', () => {
  it('usa los números libres más bajos y no pasa del máximo', () => {
    expect(lowestFreeNumbers([], 2, 10)).toEqual([1, 2]);
    expect(lowestFreeNumbers([1, 3], 2, 10)).toEqual([2, 4]);
    expect(lowestFreeNumbers([1, 2], 2, 3)).toEqual([3]);
  });
});
