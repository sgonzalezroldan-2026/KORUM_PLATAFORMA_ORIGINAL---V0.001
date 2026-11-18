import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTITY_VISIBLE_ACTIONS, READ_ACTIONS, auditCategoryOf } from '@/core/audit/audit-catalog';
import { isContributionInstant } from '@/core/audit/contribution-instant';
import { shortTitle } from '@/core/audit/audit-query';
import { DOSSIER_KIND_SLUGS, dossierReference, ENTITY_DOSSIER_KINDS, parseDossierRequest, type DossierData, type DossierInitiativeView, type DossierPayoutView } from '@/core/dossier/dossier-model';
import { buildDossierLines, dossierPdfOptions, pdfSafeText, renderDossierPdf } from '@/core/dossier/dossier-pdf';
import { DOSSIER_EMAIL_TEMPLATE_KEYS } from '@/core/dossier/dossier-texts';
import { formatCents } from '@/core/finance/money';
import { paginatePdfLines, renderLinesPdf, wrapPdfText, type PdfLine } from '@/core/pdf/text-pdf';
import { ContributionStatus, ContributionType, InitiativeFormat, LedgerAccount, LedgerJournalKind, OutboxStatus, PaymentMethod, PayoutDestination, PayoutSplitStatus, PayoutStatus, WebhookStatus } from '@/generated/prisma/enums';
import { requestIsFromOwnSite } from '@/lib/dossier/own-site';
import { entityContributionTypeOf, entityKindOf, groupEntityMovements, spainDayOf, type EntityEntry } from '@/services/dossier/dossier-kinds';
import { catalogDossierTexts } from '../support/dossier-texts';

/**
 * Sprint 5.8b · QA-SEC13 · expediente exportable: lo que viaja en la dirección, la maquetación del PDF con los textos reales de los tres idiomas y que cada
 * valor que puede salir de la base de datos tiene su texto. Los datos que lleva y el aislamiento entre entidades se prueban contra PostgreSQL real en
 * `tests/integration/dossier.spec.ts`.
 */

const LOCALES = ['es', 'ca', 'en'] as const;
const at = (iso: string) => new Date(iso);
/** Sin los saltos de línea ni las sangrías de continuación del PDF, ni los espacios duros de `Intl`. */
const plain = (value: string) => value.replace(/\s+/g, ' ');

const initiative: DossierInitiativeView = {
  id: 12,
  title: 'Toldos para el patio 🌞',
  walletEscrowId: 'WLT-ESC-112',
  format: 'BUDGET',
  status: 'CLOSED',
  createdAt: at('2026-09-01T08:00:00Z'),
  closesAt: at('2026-10-20T21:59:59Z'),
  firstPayinAt: at('2026-09-02T10:00:00Z'),
  closedAt: at('2026-10-25T09:00:00Z'),
  goalCents: 583_300,
  raisedCents: 583_300,
  totalContributions: 41,
  breakdown: { line1Cents: 400_000, line2Cents: 110_000, line3Cents: 51_000, line4Cents: 22_300 },
  contributions: [
    { type: 'DONATION', status: 'COMPLETED', count: 40, totalCents: 558_300 },
    { type: 'SPONSORSHIP', status: 'MOVED', count: 1, totalCents: 25_000 }
  ],
  matchingAddedCents: 0,
  matchingDetail: [],
  sponsorAllocations: { count: 2, totalCents: 35_000 }
};

const payout: DossierPayoutView = {
  id: 7,
  destinationType: 'PROVIDER',
  beneficiaryName: 'Toldos Mediterráneo, S.L.',
  iban: { bank: '2100', last4: '1332' },
  hasProviderInvoice: true,
  netPaidCents: 561_000,
  korumFeeSettledCents: 14_440,
  status: 'EXECUTED',
  createdAt: at('2026-10-21T09:00:00Z'),
  approvedAt: at('2026-10-22T09:00:00Z'),
  executedAt: at('2026-10-25T09:00:00Z'),
  escrowOutCents: 583_300,
  splits: [{ contributionId: 901, chargedAt: at('2026-09-02T10:00:00Z'), amountCents: 561_000, status: 'DONE', executedAt: at('2026-10-25T09:00:00Z') }],
  splitSummary: [{ status: 'DONE', count: 1, totalCents: 561_000 }],
  totalSplits: 1
};

const common = {
  generatedAt: at('2026-11-15T12:00:00Z'),
  entity: { name: 'AMPA Cervantes', legalName: 'Asociación de Madres y Padres del CEIP Cervantes' },
  initiative,
  ledger: {
    journals: [
      { id: 301, kind: 'PAYIN_DONATION', occurredAt: at('2026-09-02T10:00:00Z'), reference: 'KD-ABC123', reversesId: null, entries: [{ account: 'PSP_CLEARING', direction: 'DEBIT' as const, amountCents: 2_680 }, { account: 'INITIATIVE_ESCROW', direction: 'CREDIT' as const, amountCents: 2_500 }, { account: 'KORUM_REVENUE_GUARANTEE', direction: 'CREDIT' as const, amountCents: 180 }] },
      { id: 302, kind: 'REVERSAL', occurredAt: at('2026-09-03T10:00:00Z'), reference: null, reversesId: 301, entries: [{ account: 'INITIATIVE_ESCROW', direction: 'DEBIT' as const, amountCents: 2_500 }, { account: 'PSP_CLEARING', direction: 'CREDIT' as const, amountCents: 2_500 }] }
    ],
    movements: [],
    movementsOmitted: false,
    totalJournals: 2,
    unbalanced: 0
  },
  checks: [{ key: 'raised' as const, recordCents: 583_300, ledgerCents: 583_300 }],
  signatures: [
    { target: 'ESCROW_PAYOUT' as const, role: 'DIRECTOR', name: 'Lucía Ferrer', signedAt: at('2026-10-21T10:00:00Z'), otpVerified: true, hash: 'a'.repeat(64) },
    { target: 'ESCROW_PAYOUT' as const, role: 'COSIGNER', name: null, signedAt: at('2026-10-22T08:00:00Z'), otpVerified: true, hash: 'b'.repeat(64) }
  ],
  emails: [
    { templateKey: 'contribution.receipt', status: 'SENT', count: 40, firstAt: at('2026-09-02T10:00:00Z'), lastAt: at('2026-10-19T10:00:00Z') },
    { templateKey: 'plantilla.futura', status: 'PENDING', count: 1, firstAt: at('2026-10-19T10:00:00Z'), lastAt: at('2026-10-19T10:00:00Z') }
  ],
  audit: [
    { occurredAt: at('2026-09-01T08:00:00Z'), action: 'initiative.status_changed', actor: { kind: 'member' as const, name: 'Lucía Ferrer', role: 'DIRECTOR', roleLabel: null }, target: { type: 'Initiative', id: '12', name: 'Toldos para el patio' }, statusChange: { from: 'BUDGETING', to: 'FUNDRAISING', reason: 'PUBLISHED' } },
    { occurredAt: at('2026-10-19T10:00:00Z'), action: 'initiative.status_changed', actor: { kind: 'system' as const }, target: { type: 'Initiative', id: '12', name: null }, statusChange: { from: 'FUNDRAISING', to: 'GOAL_REACHED', reason: null } },
    { occurredAt: at('2026-10-22T09:00:00Z'), action: 'tenant.resource_not_found', actor: { kind: 'other' as const }, target: { type: 'EscrowPayout', id: null, name: null }, statusChange: null }
  ],
  auditTruncated: true
};

const consoleInitiative: DossierData = { ...common, scope: 'console', kind: 'initiative', reference: dossierReference('initiative', 12), payout };
const entityPayout: DossierData = {
  ...common,
  scope: 'entity',
  kind: 'payout',
  reference: dossierReference('payout', 7),
  payout: { ...payout, splits: [] },
  ledger: {
    journals: [],
    movements: [
      { from: '2026-09-02', to: '2026-09-05', kind: 'PAYIN_DONATION', account: 'INITIATIVE_ESCROW', direction: 'CREDIT', count: 14, totalCents: 31_200 },
      { from: '2026-10-22', to: '2026-10-22', kind: 'PAYOUT_APPROVAL', account: 'INITIATIVE_ESCROW', direction: 'DEBIT', count: 1, totalCents: 583_300 },
      { from: '2026-10-22', to: '2026-10-22', kind: 'PAYOUT_APPROVAL', account: 'ORG_PAYABLE', direction: 'CREDIT', count: 1, totalCents: 561_000 }
    ],
    movementsOmitted: false,
    totalJournals: 16,
    unbalanced: 0
  }
};
const consoleContribution: Extract<DossierData, { kind: 'contribution' }> = {
  ...common,
  scope: 'console',
  kind: 'contribution',
  reference: dossierReference('contribution', 901),
  payout: null,
  signatures: [],
  checks: [{ key: 'charged', recordCents: 2_680, ledgerCents: 2_600 }, { key: 'refunded', recordCents: 2_680, ledgerCents: 2_680 }],
  contribution: {
    id: 901, type: 'DONATION', status: 'REFUNDED', method: 'BIZUM', createdAt: at('2026-09-02T10:00:00Z'), fiscalYear: 2026, payer: { kind: 'account' }, wantsTaxCertificate: true,
    ticketQuantity: null, amountCents: 2_500, guaranteeCents: 180, matchedBonusCents: 2_500, totalChargedCents: 2_680, refundedCents: 2_680, refundedAt: at('2026-09-03T10:00:00Z'), order: 'KD-ABC123', authCode: '445566',
    notifications: [
      { receivedAt: at('2026-09-02T10:00:01Z'), transactionType: '1', response: 'OK', amountCents: 2_680, status: 'PROCESSED' },
      { receivedAt: at('2026-09-03T10:00:01Z'), transactionType: '2', response: 'KO', amountCents: 2_680, status: 'FAILED' },
      { receivedAt: at('2026-09-04T10:00:01Z'), transactionType: '77', response: 'OK', amountCents: null, status: 'RECEIVED' }
    ],
    splits: [{ source: 'campaign', payoutId: 7, amountCents: 2_500, status: 'DONE', executedAt: at('2026-10-25T09:00:00Z') }, { source: 'fund', payoutId: 2, amountCents: 100, status: 'PENDING', executedAt: null }]
  }
};

const linesOf = (data: DossierData, locale: (typeof LOCALES)[number]) => buildDossierLines(data, catalogDossierTexts(locale), locale);
const textOf = (data: DossierData, locale: (typeof LOCALES)[number]) => plain(linesOf(data, locale).map((line) => line.text).join('\n'));
/** ¿Se puede escribir ese texto en el PDF (WinAnsi) sin perder nada? */
const writable = (text: string) =>
  [...text].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return '€‚„…‘’“”•–—™'.includes(char) || [0x202f, 0x2009].includes(code) || (code >= 0x20 && code <= 0xff && !(code >= 0x7f && code <= 0x9f));
  });

describe('QA-SEC13 · qué expediente se pide (dirección web)', () => {
  it('lee el tipo y el número en las dos formas, y el pedido de Paycomet solo para una aportación', () => {
    expect(parseDossierRequest({})).toBeNull();
    expect(parseDossierRequest({ expediente: 'campana', ref: '12' })).toEqual({ kind: 'initiative', ref: { by: 'id', id: 12 } });
    expect(parseDossierRequest({ expediente: 'liquidacion:7' })).toEqual({ kind: 'payout', ref: { by: 'id', id: 7 } });
    expect(parseDossierRequest({ expediente: ['aportacion', 'campana'], ref: ' 901 ' })).toEqual({ kind: 'contribution', ref: { by: 'id', id: 901 } });
    expect(parseDossierRequest({ expediente: 'aportacion', ref: 'KD-ABC123' })).toEqual({ kind: 'contribution', ref: { by: 'order', order: 'KD-ABC123' } });
    expect(Object.values(DOSSIER_KIND_SLUGS)).toEqual(['aportacion', 'campana', 'liquidacion']);
    expect(ENTITY_DOSSIER_KINDS).toEqual(['initiative', 'payout']);
  });

  it('lo mal escrito no es un expediente: ni ceros, ni negativos, ni números enormes, ni letras donde no tocan', () => {
    for (const raw of [
      { expediente: 'campana' },
      { expediente: 'campana', ref: '0' },
      { expediente: 'campana', ref: '-3' },
      { expediente: 'campana', ref: '2147483648' },
      { expediente: 'campana', ref: '12abc' },
      { expediente: 'campana', ref: 'KD-ABC123' },
      { expediente: 'liquidacion', ref: 'KD-ABC123' },
      { expediente: 'factura', ref: '3' },
      { expediente: 'aportacion', ref: "1' OR '1'='1" },
      { expediente: 'aportacion', ref: 'x'.repeat(41) },
      { expediente: 'campana:' }
    ]) {
      expect(parseDossierRequest(raw), JSON.stringify(raw)).toBe('invalid');
    }
  });

  it('la página solo comprueba lo pedido si se llega desde la propia aplicación o escribiendo la dirección, nunca desde un enlace de otra web', () => {
    expect([null, 'same-origin', 'none'].map(requestIsFromOwnSite)).toEqual([true, true, true]);
    expect(['cross-site', 'same-site', ''].map(requestIsFromOwnSite)).toEqual([false, false, false]);
  });
});

describe('QA-SEC13 · maquetación del expediente con los textos reales', () => {
  it.each(LOCALES)('%s: los tres expedientes se componen sin que falte un texto y todo se puede escribir en el PDF', (locale) => {
    for (const data of [consoleInitiative, entityPayout, consoleContribution]) {
      const lines = linesOf(data, locale);
      expect(lines.length).toBeGreaterThan(30);
      for (const line of lines) {
        expect(writable(line.text), line.text).toBe(true);
        expect(line.text.length, line.text).toBeLessThanOrEqual(98);
        // Una clave sin traducir se vería como `audit.dossier.algo` o con las llaves de una variable sin sustituir.
        expect(line.text).not.toMatch(/audit\.dossier|\{[a-zA-Z]+\}/);
      }
      const pdf = Buffer.from(renderDossierPdf(data, catalogDossierTexts(locale), locale)).toString('latin1');
      expect(pdf.startsWith('%PDF-1.4')).toBe(true);
      expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    }
  });

  it('primero la entidad y la campaña, después el objeto del expediente con sus firmas y al final lo que lo respalda', () => {
    const headings = (data: DossierData) => linesOf(data, 'es').filter((line) => line.style === 'heading').map((line) => line.text);
    expect(headings(consoleContribution).slice(0, 4)).toEqual(['Campaña', 'Aportación', 'Avisos de Paycomet sobre este pedido', 'Liquidaciones que han enviado este cobro']);
    expect(headings(entityPayout)).toEqual(['Campaña', 'Liquidación', 'Envíos de la liquidación', 'Firmas', 'Movimientos de la hucha', 'Comprobación con los movimientos', 'Emails enviados', 'Registro de actividad', 'Notas']);
    const campaign = headings(consoleInitiative);
    expect(campaign.indexOf('Liquidación')).toBeLessThan(campaign.indexOf('Firmas'));
    expect(campaign.slice(-5)).toEqual(['Libro mayor', 'Comprobación con el libro mayor', 'Emails enviados', 'Registro de actividad', 'Notas']);
  });

  it('los importes salen con el formato de cada idioma, las 4 líneas suman la meta y la liquidación cuadra con lo que salió de la hucha', () => {
    for (const locale of LOCALES) {
      const text = textOf(consoleInitiative, locale);
      // 7.860 = 583.300 − 561.000 − 14.440: el coste de la pasarela incluido en la meta.
      for (const cents of [583_300, 400_000, 110_000, 51_000, 22_300, 561_000, 14_440, 7_860, 35_000]) expect(text).toContain(plain(formatCents(cents, locale)));
    }
    const lines = initiative.breakdown;
    if (lines === null || lines === 'mismatch') throw new Error('se esperaba el desglose');
    expect(lines.line1Cents + lines.line2Cents + lines.line3Cents + lines.line4Cents).toBe(initiative.goalCents);
    const text = textOf(consoleInitiative, 'es');
    expect(text).toContain('Coste de la pasarela incluido en la meta: 78,60 €');
    expect(text).toContain('Total que salió de la hucha (suma de las tres cifras anteriores): 5.833,00 €');
    expect(text).toContain('cobrada aquí; el dinero pasó a la bolsa del comercio. Lo que de esa bolsa se destina a esta campaña consta en la línea de patrocinios colocados');
    // Como valor de «Estado:», con mayúscula inicial, igual que el estado de la campaña.
    expect(text).toContain('Estado: Cerrada');
    expect(text).toContain('Estado: Enviada');
    expect(textOf(consoleContribution, 'es')).toContain('Estado: Devuelta');
    expect(text).toContain('Patrocinios colocados en esta campaña desde la bolsa de cada comercio: 2 comercios · 350,00 €');
  });

  it('si las cifras guardadas no cuadran con la meta, lo dice en vez de callar el desglose', () => {
    const text = textOf({ ...consoleInitiative, initiative: { ...initiative, breakdown: 'mismatch' } }, 'es');
    expect(text).toContain('ATENCIÓN: las cifras guardadas de esta campaña no cuadran con su meta');
  });

  it('dice si cada cifra coincide con el libro mayor, y lo dice bien alto cuando no', () => {
    const ok = textOf(consoleInitiative, 'es');
    expect(ok).toContain('COINCIDE');
    expect(ok).not.toContain('NO COINCIDE');
    expect(ok).toContain('el debe es igual al haber');
    const wrong = textOf(consoleContribution, 'es');
    expect(wrong).toContain('Total cobrado: ficha 26,80 € · libro mayor 26,00 € · NO COINCIDE');
    expect(wrong).toContain('Importe devuelto: ficha 26,80 € · libro mayor 26,80 € · COINCIDE');
    expect(textOf({ ...consoleInitiative, ledger: { ...consoleInitiative.ledger, unbalanced: 1 } }, 'es')).toContain('ATENCIÓN');
  });

  it('en la consola, debe y haber, pedidos y cobro a cobro; en el de la entidad, lo que entra y sale sumado por tipo, sin horas ni números de cobro', () => {
    const consoleText = textOf(consoleInitiative, 'es');
    expect(consoleText).toMatch(/Debe · Dinero cobrado que está en Paycomet/);
    expect(consoleText).toContain('pedido KD-ABC123');
    // El rótulo y su código van unidos por un espacio duro: al saltar de línea no queda «pedido» arriba y el código abajo.
    for (const locale of LOCALES) {
      const titles = linesOf(consoleInitiative, locale).filter((line) => line.text.includes('KD-ABC123'));
      expect(titles.length).toBeGreaterThan(0);
      for (const line of titles) expect(line.text).toMatch(/(pedido|comanda|order)\u00a0KD-ABC123/);
    }
    expect(consoleText).toContain('Aportación n.º 901, cobrada el 2 de septiembre de 2026 a las 12:00:00');
    const entityText = textOf(entityPayout, 'es');
    expect(entityText).not.toMatch(/Debe ·|Haber ·|Asiento|n\.º 901|KD-ABC123/);
    expect(entityText).toContain('del 2 de septiembre de 2026 al 5 de septiembre de 2026 · Cobro de una donación (14 movimientos) · Entra · Hucha de la iniciativa · 312,00 €');
    expect(entityText).toContain('se suman por tipo para toda la campaña');
    expect(entityText).toContain('22 de octubre de 2026 · Liquidación aprobada (1 movimiento) · Sale · Hucha de la iniciativa · 5.833,00 €');
    // Nada ligado a una aportación lleva hora: ni los avisos, ni el primer cobro, ni los cambios de estado, ni el registro, que van solo con su día.
    const entityCampaign = textOf({ ...consoleInitiative, scope: 'entity' }, 'es');
    expect(entityCampaign).toContain('- 19 de octubre de 2026: de «Recaudando» a «¡Conseguido!»');
    expect(entityCampaign).toContain('- 1 de septiembre de 2026 · Cambio de estado de una campaña');
    expect(consoleText).toContain('- 19 de octubre de 2026 a las 12:00:00: de «Recaudando» a «¡Conseguido!»');
    expect(entityText).toContain('- Recibo de una aportación · enviado · 40 emails · entre el 2 de septiembre de 2026 y el 19 de octubre de 2026');
    expect(textOf({ ...consoleInitiative, scope: 'entity' }, 'es')).toContain('Primer cobro: 2 de septiembre de 2026 Cerrada el');
    expect(consoleText).toContain('Primer cobro: 2 de septiembre de 2026 a las 12:00:00');
    // De los envíos, cuántos y cuánto; nunca la fecha y el importe de cada cobro.
    expect(entityText).toContain('enviado: 1 envío · 5.610,00 €');
    expect(entityText).not.toContain('cobrada el');
    // Los movimientos van sumados por tipo, con sus días: ninguna de sus líneas lleva una hora.
    expect(linesOf(entityPayout, 'es').filter((line) => / movimientos?\) /.test(line.text)).every((line) => !/\d{2}:\d{2}/.test(line.text))).toBe(true);
    expect(entityText).toContain('la diferencia es la comisión de KORUM y el coste de la pasarela');
    // El IBAN del proveedor nunca va entero: código de entidad y cuatro últimos dígitos.
    expect(entityText).toContain('código de entidad 2100, termina en 1332');
    expect(entityText).not.toContain('movimientos más recientes de');
  });

  it('nombra solo a quien firma hoy; quita los emojis del título y avisa de las listas cortadas', () => {
    const text = textOf(consoleInitiative, 'es');
    expect(text).toContain('Dirección: Lucía Ferrer, firmó el 21 de octubre de 2026 a las 12:00:00 (código de un solo uso: sí).');
    // En el registro, el cargo con el mismo nombre que en las firmas, en el idioma del expediente.
    expect(text).toContain('Quién: Lucía Ferrer · Dirección');
    expect(textOf({ ...consoleInitiative, audit: [{ ...common.audit[0]!, actor: { kind: 'member', name: 'Lucía Ferrer', role: 'DIRECTOR', roleLabel: 'Dirección del centro' } }] }, 'en')).toMatch(/Who: Lucía Ferrer · (?!Dirección)/);
    expect(text).toContain('Cofirma: una persona que ya no firma por la entidad');
    expect(text).toContain('Toldos para el patio');
    expect(text).not.toContain('?');
    expect(text).toContain('motivo: la entidad la publicó');
    expect(text).toContain('sin motivo anotado');
    expect(text).toContain('Se pidió algo que no existe o que no es de la entidad');
    expect(text).toMatch(/registros más recientes/);
    expect(pdfSafeText('Fiesta 🎉 de fin de curso ➔ patio 👩‍👧')).toBe('Fiesta de fin de curso -> patio');
  });

  it('los emails salen por lo que son, no por el código de su plantilla; uno que aún no tiene nombre es «otro aviso»', () => {
    const text = textOf(consoleInitiative, 'es');
    expect(text).toContain('- Recibo de una aportación · enviado · 40 emails');
    expect(text).toContain('- otro aviso · en cola · 1 email');
    expect(text).not.toMatch(/contribution\.receipt|plantilla\.futura/);
  });

  it('el expediente de una aportación no trae ningún dato de la persona, y los avisos de Paycomet se leen sin códigos', () => {
    const text = textOf(consoleContribution, 'es');
    expect(text).toContain('Quién paga: una cuenta registrada');
    expect(text).not.toMatch(/@|NIF: |usr_|identificador interno/);
    expect(text).toContain('Pedido de Paycomet: KD-ABC123');
    expect(text).toContain('Liquidación del Fondo de actividades n.º 2');
    expect(text).toContain('· cobro · aceptado · 26,80 € · procesado');
    expect(text).toContain('· devolución · rechazado (KO) · 26,80 € · falló al procesarse');
    expect(text).toContain('· operación n.º 77 · aceptado · no consta · recibido, sin procesar');
    expect(textOf({ ...consoleContribution, contribution: { ...consoleContribution.contribution, type: 'MATCHING_FUND', payer: { kind: 'matching' } } }, 'es')).toContain('la bolsa Matching 2x de un comercio (cobrada antes con su patrocinio)');
    const untouched = textOf({ ...consoleContribution, contribution: { ...consoleContribution.contribution, refundedCents: 0, refundedAt: null, payer: { kind: 'erasedAccount' } } }, 'es');
    expect(untouched).toContain('Devuelto: no se ha devuelto nada');
    expect(untouched).toContain('Quién paga: una cuenta ya suprimida');
  });

  it('las fechas llevan siempre dos cifras en la hora y, en inglés, el día antes que el mes', () => {
    expect(textOf(consoleInitiative, 'es')).toContain('Generado el: 15 de noviembre de 2026 a las 13:00:00');
    expect(textOf(consoleInitiative, 'es')).toContain('Creada el: 1 de septiembre de 2026 a las 10:00:00');
    expect(textOf(consoleInitiative, 'ca')).toContain('15 de novembre del 2026, a les 13:00:00');
    expect(textOf(consoleInitiative, 'en')).toMatch(/Generated on: 15 November 2026( at|,) 13:00:00/);
    const withPayout = (changes: Partial<DossierPayoutView>): DossierData => ({ ...common, scope: 'entity', kind: 'payout', reference: dossierReference('payout', 7), ledger: entityPayout.ledger, payout: { ...payout, splits: [], ...changes } });
    expect(textOf(withPayout({ status: 'PENDING_DOUBLE_CHECK', approvedAt: null, executedAt: null, escrowOutCents: null, splitSummary: [], totalSplits: 0 }), 'es')).toMatch(/Aprobada el: todavía no[\s\S]*Enviada el: todavía no[\s\S]*Todavía no hay envíos/);
    expect(textOf(withPayout({ splitSummary: [], totalSplits: 0 }), 'es')).toContain('No constan envíos de esta liquidación');
    // Si de la hucha salió menos que el proyecto y la comisión juntos, se dice (y el total sigue a la vista).
    const short = textOf(withPayout({ escrowOutCents: 500_000 }), 'es');
    expect(short).toContain('Total que salió de la hucha (suma de las tres cifras anteriores): 5.000,00 €');
    expect(short).toContain('ATENCIÓN: de la hucha salió menos');
    expect(short).not.toContain('Coste de la pasarela incluido en la meta');
    // Una campaña cerrada sin fecha guardada no está «todavía sin cerrar».
    expect(textOf({ ...consoleInitiative, initiative: { ...initiative, closedAt: null } }, 'es')).toContain('Cerrada el: sin fecha anotada');
    expect(textOf({ ...consoleInitiative, initiative: { ...initiative, closedAt: null, status: 'FUNDRAISING' } }, 'es')).toContain('Cerrada el: todavía no');
  });
});

describe('QA-SEC13 · el documento: páginas numeradas con su referencia y ningún apartado solo al pie', () => {
  const body = (count: number): PdfLine[] => Array.from({ length: count }, (_, index) => ({ style: 'body' as const, text: `línea ${index + 1}` }));

  it('cada página lleva al pie la referencia y «Página n de N», y el documento su título', () => {
    const lines = linesOf(consoleInitiative, 'es');
    const options = dossierPdfOptions(consoleInitiative, catalogDossierTexts('es'));
    const pages = paginatePdfLines([...lines, ...body(200)], options);
    expect(pages.length).toBeGreaterThan(2);
    const pdf = Buffer.from(renderLinesPdf([...lines, ...body(200)], options)).toString('latin1');
    for (let page = 1; page <= pages.length; page += 1) expect(pdf).toContain(`(EXP-C-12 \\267 P\\341gina ${page} de ${pages.length}) Tj`);
    expect(pdf).toContain('/Title (Expediente de una campa\\361a \\267 EXP-C-12)');
    expect(pdf).toMatch(/\/Info \d+ 0 R/);
    expect(Buffer.from(renderDossierPdf(consoleInitiative, catalogDossierTexts('en'), 'en')).toString('latin1')).toContain('Page 1 of ');
  });

  it('un apartado que quedaría como última línea de una página pasa a la siguiente con su contenido', () => {
    // 61 líneas de cuerpo caben en una página con pie (718 puntos, 12 por línea, menos el título del apartado).
    for (const before of [55, 56, 57, 58, 59]) {
      const lines: PdfLine[] = [...body(before), { style: 'body', text: '' }, { style: 'heading', text: 'Apartado' }, ...body(10)];
      const pages = paginatePdfLines(lines, { footer: () => 'pie', keepHeadings: true });
      for (const page of pages) expect(page[page.length - 1]!.style, `con ${before} líneas antes`).not.toBe('heading');
      expect(pages.flat().filter((line) => line.text !== '')).toHaveLength(before + 11);
    }
  });

  it('una firma no se separa de su huella, un elemento de varias líneas no se parte y un apartado no se queda con una sola línea al pie', () => {
    const options = { footer: () => 'pie', keepHeadings: true };
    for (const before of [56, 57, 58, 59, 60, 61]) {
      const signature: PdfLine[] = [{ style: 'body', text: '- firma', keepWithNext: true }, { style: 'body', text: '    huella' }];
      const pages = paginatePdfLines([...body(before), ...signature, ...body(5)], options);
      const pageOf = (text: string) => pages.findIndex((page) => page.some((line) => line.text === text));
      expect(pageOf('- firma'), `con ${before} líneas antes`).toBe(pageOf('    huella'));
      expect(pages.flat()).toHaveLength(before + 7);
    }
    for (const before of [55, 56, 57, 58, 59, 60]) {
      const section: PdfLine[] = [{ style: 'body', text: '' }, { style: 'heading', text: 'Notas' }, { style: 'body', text: 'primera' }, { style: 'body', text: 'segunda' }, { style: 'body', text: 'tercera' }];
      const pages = paginatePdfLines([...body(before), ...section], options);
      const page = pages.find((candidate) => candidate.some((line) => line.text === 'Notas'))!;
      const after = page.slice(page.findIndex((line) => line.text === 'Notas') + 1).filter((line) => line.text !== '');
      expect(after.length, `con ${before} líneas antes`).toBeGreaterThanOrEqual(2);
    }
    // En el expediente: cada firma lleva la marca, y cada línea de un elemento partido también.
    const lines = linesOf(consoleInitiative, 'es');
    const hash = lines.findIndex((line) => line.text.includes('Huella de la firma'));
    expect(lines[hash - 1]!.keepWithNext).toBe(true);
    // La frase que presenta una lista viaja con su primera línea de datos.
    const intro = lines.findIndex((line) => line.text.includes('cada envío es la parte de un cobro original'));
    expect(lines[intro]!.keepWithNext).toBe(true);
    // Y entera: en el expediente de la entidad, las dos frases que presentan los movimientos no se parten entre dos hojas.
    const entityLines = linesOf(entityPayout, 'es');
    const start = entityLines.findIndex((line) => line.text.startsWith('Lo que entra y lo que sale'));
    const firstRow = entityLines.findIndex((line, index) => index > start && line.text.startsWith('- '));
    expect(start).toBeGreaterThan(0);
    expect(firstRow - start).toBeGreaterThan(3);
    expect(firstRow - start).toBeLessThan(11);
    expect(entityLines.slice(start, firstRow).every((line) => line.keepWithNext === true)).toBe(true);
  });

  it('los demás PDF del proyecto no cambian: sin opciones no hay pie, ni título, ni se mueve ninguna línea', () => {
    const lines: PdfLine[] = [{ style: 'title', text: 'Justificante' }, ...body(70), { style: 'heading', text: 'Notas' }, ...body(3)];
    const pdf = Buffer.from(renderLinesPdf(lines)).toString('latin1');
    expect(pdf).not.toMatch(/\/Info|\/Title/);
    expect(paginatePdfLines(lines).map((page) => page.length)).toEqual(paginatePdfLines(lines, {}).map((page) => page.length));
    expect(paginatePdfLines(lines).flat()).toEqual(lines);
  });
});

describe('QA-SEC13 · el Auto-Impulso no se distingue en el expediente de la entidad, tampoco cuando KORUM lo recupera', () => {
  it('su asiento es una donación más y su devolución a KORUM, una devolución más', () => {
    expect(entityKindOf('SELF_BOOST_INJECTION', null, 'BUDGET')).toBe('PAYIN_DONATION');
    expect(entityKindOf('REVERSAL', 'SELF_BOOST_INJECTION', 'BUDGET')).toBe('ESCROW_REFUND_DONOR');
    expect(entityKindOf('REVERSAL', 'MATCHING_RELEASE', 'BUDGET')).toBe('MATCHING_UNDONE');
    expect(entityKindOf('REVERSAL', 'PAYOUT_APPROVAL', 'BUDGET')).toBe('REVERSAL');
    expect(entityKindOf('PAYIN_DONATION', null, 'BUDGET')).toBe('PAYIN_DONATION');
    // En una taquilla no hay donaciones: «una donación» solo podría ser de KORUM. Cuenta como una entrada más.
    expect(entityKindOf('SELF_BOOST_INJECTION', null, 'TICKETING')).toBe('PAYIN_TICKET');
    expect(entityKindOf('REVERSAL', 'SELF_BOOST_INJECTION', 'TICKETING')).toBe('ESCROW_REFUND_DONOR');
    expect([entityContributionTypeOf('SELF_BOOST', 'BUDGET'), entityContributionTypeOf('SELF_BOOST', 'TICKETING'), entityContributionTypeOf('TICKET', 'TICKETING')]).toEqual(['DONATION', 'TICKET', 'TICKET']);
    for (const format of ['BUDGET', 'TICKETING']) for (const kind of Object.values(LedgerJournalKind)) expect(entityKindOf(kind, null, format)).not.toBe('SELF_BOOST_INJECTION');
  });

  it('lo que sale de aportaciones va en una sola fila por tipo para toda la campaña, y los totales no cambian', () => {
    const donation = (iso: string, amountCents: number): EntityEntry => ({ occurredAt: at(iso), kind: 'PAYIN_DONATION', account: 'INITIATIVE_ESCROW', direction: 'CREDIT', amountCents });
    const entries: EntityEntry[] = [
      donation('2026-09-23T10:00:00Z', 3_000),
      donation('2026-09-27T10:00:00Z', 5_600),
      donation('2026-09-30T10:00:00Z', 1_300),
      donation('2026-10-01T10:00:00Z', 2_000),
      donation('2026-10-09T10:00:00Z', 900),
      { occurredAt: at('2026-10-20T10:00:00Z'), kind: 'PAYOUT_APPROVAL', account: 'INITIATIVE_ESCROW', direction: 'DEBIT', amountCents: 12_800 },
      { occurredAt: at('2026-10-20T10:00:00Z'), kind: 'PAYOUT_APPROVAL', account: 'ORG_PAYABLE', direction: 'CREDIT', amountCents: 12_000 },
      { occurredAt: at('2026-10-21T10:00:00Z'), kind: 'ESCROW_REFUND_DONOR', account: 'INITIATIVE_ESCROW', direction: 'DEBIT', amountCents: 700 }
    ];
    const rows = groupEntityMovements(entries);
    // Un día con una sola donación ya no es una fila: todas las donaciones van juntas, entre su primer y su último día.
    expect(rows.filter((row) => row.kind === 'PAYIN_DONATION')).toEqual([{ from: '2026-09-23', to: '2026-10-09', kind: 'PAYIN_DONATION', account: 'INITIATIVE_ESCROW', direction: 'CREDIT', count: 5, totalCents: 12_800 }]);
    // La aprobación de la liquidación no es una aportación: va por su día, con sus dos cuentas.
    expect(rows.filter((row) => row.kind === 'PAYOUT_APPROVAL').map((row) => [row.from, row.to, row.account, row.count])).toEqual([['2026-10-20', '2026-10-20', 'INITIATIVE_ESCROW', 1], ['2026-10-20', '2026-10-20', 'ORG_PAYABLE', 1]]);
    expect(rows.filter((row) => row.kind === 'ESCROW_REFUND_DONOR')).toHaveLength(1);
    // Ni un céntimo ni un movimiento de diferencia con los apuntes.
    expect(rows.reduce((sum, row) => sum + (row.count ?? 0), 0)).toBe(entries.length);
    const net = (list: ReadonlyArray<{ direction: string; totalCents?: number; amountCents?: number }>) => list.reduce((sum, item) => sum + (item.direction === 'CREDIT' ? 1 : -1) * (item.totalCents ?? item.amountCents ?? 0), 0);
    expect(net(rows)).toBe(net(entries));
  });

  it('restar filas de dos tipos nunca deja una sola aportación: ni los cobros se desglosan por días ni lo que repite sus importes (bolsa Matching, devoluciones, envíos)', () => {
    const entry = (kind: string, direction: 'DEBIT' | 'CREDIT', iso: string, amountCents: number): EntityEntry => ({ occurredAt: at(iso), kind, account: 'INITIATIVE_ESCROW', direction, amountCents });
    // Día 1: dos donaciones sin emparejar. Día 2: una sola, de 37,00 €, emparejada por la bolsa. Días 3 y 4: tres cada día, emparejadas.
    const day = (number: number, hour: number) => `2026-10-0${number}T${String(hour).padStart(2, '0')}:00:00Z`;
    const matched: Array<[number, number, number]> = [[2, 10, 3_700], [3, 10, 1_000], [3, 11, 1_200], [3, 12, 1_300], [4, 10, 900], [4, 11, 800], [4, 12, 700]];
    const entries: EntityEntry[] = [
      entry('PAYIN_DONATION', 'CREDIT', day(1, 10), 2_000),
      entry('PAYIN_DONATION', 'CREDIT', day(1, 11), 1_500),
      ...matched.flatMap(([number, hour, cents]) => [entry('PAYIN_DONATION', 'CREDIT', day(number, hour), cents), entry('MATCHING_RELEASE', 'CREDIT', day(number, hour), cents)]),
      // Una devolución masiva en dos días y los envíos de la liquidación, que van cobro a cobro.
      ...matched.slice(0, 4).map(([, hour, cents], index) => entry('ESCROW_REFUND_DONOR', 'DEBIT', day(index < 1 ? 6 : 7, hour), cents)),
      ...matched.slice(4).map(([, hour, cents], index) => entry('SPLIT_PAYOUT_ORGANIZATION', 'DEBIT', day(index < 2 ? 8 : 9, hour), cents))
    ];
    const rows = groupEntityMovements(entries);
    const of = (kind: string) => rows.filter((row) => row.kind === kind);
    // Cada tipo, en una sola fila con todo. (Con los cobros por días, la fila de la bolsa menos las de los días 3 y 4 dejaba la donación sola del día 2.)
    expect(of('PAYIN_DONATION').map((row) => [row.from, row.to, row.count, row.totalCents])).toEqual([['2026-10-01', '2026-10-04', 9, 13_100]]);
    // Lo que añade la bolsa Matching va sin recuento: su número, restado del de donaciones, diría cuántas quedaron sin emparejar.
    expect(of('MATCHING_RELEASE')).toEqual([{ from: null, to: null, kind: 'MATCHING_RELEASE', account: 'INITIATIVE_ESCROW', direction: 'CREDIT', count: null, totalCents: 9_600 }]);
    expect(of('ESCROW_REFUND_DONOR').map((row) => [row.from, row.to, row.count])).toEqual([['2026-10-06', '2026-10-07', 4]]);
    expect(of('SPLIT_PAYOUT_ORGANIZATION').map((row) => [row.from, row.to, row.count])).toEqual([['2026-10-08', '2026-10-09', 3]]);
    // Ninguna combinación de filas (sumando unas y restando otras) deja exactamente un movimiento con el importe de la donación sola del día 2.
    const lone = 3_700;
    const signs = [-1, 0, 1];
    const combos = rows.reduce<Array<{ count: number; cents: number }>>((all, row) => all.flatMap((sum) => signs.map((sign) => ({ count: sum.count + sign * (row.count ?? 0), cents: sum.cents + sign * row.totalCents }))), [{ count: 0, cents: 0 }]);
    expect(combos.filter((sum) => Math.abs(sum.count) === 1 && Math.abs(sum.cents) === lone)).toEqual([]);
    expect(rows.reduce((sum, row) => sum + (row.count ?? 1), 0)).toBeLessThanOrEqual(entries.length);
    expect(rows.reduce((sum, row) => sum + row.totalCents, 0)).toBe(entries.reduce((sum, item) => sum + item.amountCents, 0));
  });

  it('en el panel de la entidad, las filas anotadas en el instante de una aportación van solo con su día', () => {
    const change = (reason: string | null) => ({ action: 'initiative.status_changed', statusChange: { from: 'FUNDRAISING' as const, to: 'GOAL_REACHED' as const, reason } });
    expect(isContributionInstant(change('GOAL_REACHED'))).toBe(true);
    expect(isContributionInstant(change('REOPENED_BY_REVERSAL'))).toBe(true);
    expect(isContributionInstant({ action: 'payment.chargeback', statusChange: null })).toBe(true);
    // Lo que un contracargo o una devolución provocan en ese mismo instante: si llevaran hora, la dirían por la fila de al lado.
    for (const action of ['payment.refund_after_settlement', 'initiative.resized_rescaled', 'initiative.resized_emptied']) expect(isContributionInstant({ action, statusChange: null }), action).toBe(true);
    expect(isContributionInstant(change('RESIZED_LEFT_EMPTY'))).toBe(true);
    // Lo que hace la entidad o el calendario conserva su hora.
    expect(isContributionInstant(change('PUBLISHED'))).toBe(false);
    expect(isContributionInstant(change('DEADLINE_PASSED'))).toBe(false);
    expect(isContributionInstant({ action: 'payout.requested', statusChange: null })).toBe(false);
  });

  it('la bolsa Matching 2x nunca sale con su recuento en el expediente de la entidad: con cuatro donaciones y tres emparejadas no se puede saber cuál quedó sin emparejar', () => {
    const entry = (kind: string, direction: 'DEBIT' | 'CREDIT', iso: string, amountCents: number): EntityEntry => ({ occurredAt: at(iso), kind, account: 'INITIATIVE_ESCROW', direction, amountCents });
    const donations: Array<[string, number]> = [['2026-10-01T10:00:00Z', 2_000], ['2026-10-02T10:00:00Z', 1_000], ['2026-10-03T10:00:00Z', 1_500], ['2026-10-04T10:00:00Z', 900]];
    const movements = groupEntityMovements([
      ...donations.map(([iso, cents]) => entry('PAYIN_DONATION', 'CREDIT', iso, cents)),
      ...donations.slice(1).map(([iso, cents]) => entry('MATCHING_RELEASE', 'CREDIT', iso, cents)),
      // Una de las emparejadas se devuelve: la bolsa deja de añadir lo suyo (en el libro, un contra-asiento de la liberación).
      entry(entityKindOf('REVERSAL', 'MATCHING_RELEASE', 'BUDGET'), 'DEBIT', '2026-10-06T10:00:00Z', 900),
      entry('ESCROW_REFUND_DONOR', 'DEBIT', '2026-10-06T10:00:00Z', 900)
    ]);
    expect(movements.find((row) => row.kind === 'PAYIN_DONATION')).toMatchObject({ count: 4, totalCents: 5_400 });
    expect(movements.find((row) => row.kind === 'MATCHING_RELEASE')).toMatchObject({ from: null, to: null, count: null, totalCents: 3_400 });
    expect(movements.find((row) => row.kind === 'MATCHING_UNDONE')).toMatchObject({ from: null, to: null, count: null, totalCents: 900, direction: 'DEBIT' });
    // Y van al final, en un orden fijo: su sitio en la lista tampoco dice cuándo fueron.
    expect(movements.slice(-2).map((row) => row.kind)).toEqual(['MATCHING_RELEASE', 'MATCHING_UNDONE']);
    expect(movements.filter((row) => row.kind === 'REVERSAL')).toEqual([]);
    const data: DossierData = { ...entityPayout, kind: 'initiative', reference: dossierReference('initiative', 12), initiative: { ...initiative, contributions: [{ type: 'DONATION', status: 'COMPLETED', count: 4, totalCents: 5_400 }], matchingAddedCents: 3_400, sponsorAllocations: { count: 0, totalCents: 0 } }, ledger: { ...entityPayout.ledger, movements, totalJournals: 9 } };
    for (const locale of LOCALES) {
      const lines = linesOf(data, locale).map((line) => plain(line.text));
      const pool = lines.filter((line) => /^- .*Matching 2x/.test(line));
      expect(pool.length, locale).toBe(3);
      // Ninguna línea de la bolsa dice cuántas ni cuándo: ni «3 aportaciones», ni «(3 movimientos)», ni un año.
      for (const line of pool) expect(line, locale).not.toMatch(/\b3\b|\(\d+ |2026/);
    }
    const text = textOf(data, 'es');
    expect(text).toContain('Lo que ha añadido la bolsa Matching 2x de un comercio: 34,00 €');
    expect(text).toContain('- En toda la campaña · Matching 2x: dinero de un comercio que se suma a la campaña · Entra · Hucha de la iniciativa · 34,00 €');
    expect(text).toContain('- En toda la campaña · Bolsa Matching 2x: lo que dejó de añadir al devolverse donaciones · Sale · Hucha de la iniciativa · 9,00 €');
    expect(text).toContain('Lo que añade la bolsa Matching 2x va sin días ni número.');
    expect(text).not.toContain('Bolsa Matching 2x de un comercio ·');
  });

  it('las filas de la bolsa Matching no llevan días: con dos devoluciones en dos días y una sola emparejada, no se sabe cuál fue cuál, ni por el orden de las filas', () => {
    const entry = (kind: string, iso: string, amountCents: number): EntityEntry => ({ occurredAt: at(iso), kind, account: 'INITIATIVE_ESCROW', direction: 'DEBIT', amountCents });
    const undone = entityKindOf('REVERSAL', 'MATCHING_RELEASE', 'BUDGET');
    // La devolución emparejada (20,00 €), el día 6 o el día 9: el resultado tiene que ser el mismo.
    const rowsWith = (matchedDay: string) => groupEntityMovements([entry('ESCROW_REFUND_DONOR', '2026-10-06T10:00:00Z', matchedDay === '06' ? 2_000 : 2_500), entry('ESCROW_REFUND_DONOR', '2026-10-09T10:00:00Z', matchedDay === '06' ? 2_500 : 2_000), entry(undone, `2026-10-${matchedDay}T10:00:00Z`, 2_000)]);
    expect(rowsWith('06')).toEqual(rowsWith('09'));
    expect(rowsWith('06')).toEqual([
      { from: '2026-10-06', to: '2026-10-09', kind: 'ESCROW_REFUND_DONOR', account: 'INITIATIVE_ESCROW', direction: 'DEBIT', count: 2, totalCents: 4_500 },
      { from: null, to: null, kind: 'MATCHING_UNDONE', account: 'INITIATIVE_ESCROW', direction: 'DEBIT', count: null, totalCents: 2_000 }
    ]);
    // Tampoco si lo de la bolsa es anterior a todo lo demás: sigue al final.
    expect(groupEntityMovements([entry(undone, '2026-09-01T10:00:00Z', 2_000), entry('ESCROW_REFUND_DONOR', '2026-10-06T10:00:00Z', 2_000)]).map((row) => row.kind)).toEqual(['ESCROW_REFUND_DONOR', 'MATCHING_UNDONE']);
  });

  it('con demasiados movimientos no se suma ninguno (una suma parcial, restada de las tablas, dejaría los que faltan), y se dice', () => {
    const text = textOf({ ...entityPayout, ledger: { ...entityPayout.ledger, movements: [], movementsOmitted: true, totalJournals: 50_001 } }, 'es');
    expect(text).toContain('Esta campaña tiene 50.001 movimientos: son demasiados para sumarlos aquí.');
    const omitted: DossierData = { ...entityPayout, ledger: { ...entityPayout.ledger, movements: [], movementsOmitted: true, totalJournals: 50_001 } };
    expect(textOf(omitted, 'ca')).toContain('té 50.001 moviments');
    expect(textOf(omitted, 'en')).toContain('has 50,001 movements');
    // También en las listas cortadas de la consola.
    expect(textOf({ ...consoleInitiative, ledger: { ...consoleInitiative.ledger, totalJournals: 12_345 } }, 'es')).toContain('los 2 más recientes de 12.345');
    expect(text).not.toContain('No hay movimientos.');
  });

  it('un título recortado no deja un conector colgando antes de los puntos suspensivos', () => {
    expect(shortTitle('Renovación de Canchas de Baloncesto y Fútbol Sala', 30)).toBe('Renovación de Canchas…');
    expect(shortTitle('Toldos para el patio', 44)).toBe('Toldos para el patio');
    expect(shortTitle('Material de Laboratorio y Robótica para el aula', 30)).not.toMatch(/ (y|de|para|el)…$/);
    expect(shortTitle('Mejoras sobre el patio de infantil del centro', 16)).toBe('Mejoras…');
    expect(shortTitle('Fiesta, de fin de curso con toda la comunidad', 12)).toBe('Fiesta…');
    expect(shortTitle('Material sense el qual no es pot fer la classe', 18)).toBe('Material…');
    expect(shortTitle('New books from our families and friends', 17)).toBe('New books…');
    // Tampoco una raya, una barra, un «&» o un «+» sueltos.
    expect(shortTitle('Material escolar – ayudas para familias – curso nuevo', 43)).toBe('Material escolar – ayudas para familias…');
    expect(shortTitle('Gran Fiesta de Primavera / Mercadillo solidario del centro', 28)).toBe('Gran Fiesta de Primavera…');
    expect(shortTitle('Pizarras digitales + proyectores para todas las aulas', 22)).toBe('Pizarras digitales…');
    expect(shortTitle('Bibliotecas, juegos & más cosas para el patio', 23)).toBe('Bibliotecas, juegos…');
  });

  it('un importe no se separa de su «€» al saltar de línea', () => {
    const amount = formatCents(75_000, 'ca');
    expect(amount).toMatch(/\u00a0€$/);
    const lines = wrapPdfText(`Patrocinis col·locats en aquesta campanya des de la bossa de cada comerç: 3 comerços · ${amount}`, 96);
    expect(lines.some((line) => line.trim() === '€')).toBe(false);
    expect(lines[lines.length - 1]).toContain(amount);
    // Y el espacio duro se escribe en el PDF como tal, no como «?».
    expect(Buffer.from(renderLinesPdf([{ style: 'body', text: amount }])).toString('latin1')).toContain('750,00\\240\\200');
  });

  it('un separador de línea pegado en un texto sigue separando palabras, y una palabra larguísima se trocea sin perder nada', () => {
    expect(wrapPdfText('Hola\u2028adiós\u2029y\u3000más\u000bcosas', 98)).toEqual(['Hola adiós y más cosas']);
    const long = `${'a'.repeat(60)}\u00a0${'b'.repeat(60)}`;
    const chunks = wrapPdfText(long, 98);
    expect(chunks.map((chunk) => chunk.length)).toEqual([98, 23]);
    expect(chunks.join('')).toBe(long);
  });

  it('los movimientos se agrupan por el día de España, no por el de UTC', () => {
    expect(spainDayOf(at('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(spainDayOf(at('2026-07-01T21:59:59Z'))).toBe('2026-07-01');
    expect(spainDayOf(at('2026-07-01T22:00:00Z'))).toBe('2026-07-02');
  });
});

describe('QA-SEC13 · cada valor que puede salir de la base de datos tiene su texto en los tres idiomas', () => {
  const groups: Array<[string, readonly string[]]> = [
    ['accounts', Object.values(LedgerAccount)],
    ['journalKinds', Object.values(LedgerJournalKind)],
    ['contributionTypes', Object.values(ContributionType)],
    // `MOVED` y `POOL` no son estados de la base: son los de un patrocinio cobrado en la campaña cuyo dinero no cuenta en su hucha por esa línea.
    ['contributionStatuses', [...Object.values(ContributionStatus), 'MOVED', 'POOL', 'POOL_PARTLY_MOVED', 'CHARGEBACK_AFTER_PAYOUT', 'REFUNDED_AFTER_PAYOUT']],
    ['methods', Object.values(PaymentMethod)],
    ['payoutStatuses', Object.values(PayoutStatus)],
    ['splitStatuses', Object.values(PayoutSplitStatus)],
    ['destinations', Object.values(PayoutDestination)],
    ['emailStatuses', Object.values(OutboxStatus)],
    ['notificationStatuses', Object.values(WebhookStatus)],
    ['formats', Object.values(InitiativeFormat)]
  ];
  const flatten = (node: unknown, prefix = ''): string[] => (typeof node === 'string' ? [prefix] : Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => flatten(value, prefix ? `${prefix}.${key}` : key)));

  it.each(LOCALES)('%s', (locale) => {
    const messages = JSON.parse(readFileSync(path.join(process.cwd(), 'messages', `${locale}.json`), 'utf8')) as { audit: { dossier: Record<string, Record<string, string>> } };
    for (const [group, values] of groups) expect(Object.keys(messages.audit.dossier[group] ?? {}).sort(), group).toEqual([...values].sort());
    // Cada plantilla de email del catálogo tiene su nombre en lenguaje llano, y no sobra ninguno.
    expect(flatten(messages.audit.dossier.emailTemplates).sort()).toEqual([...DOSSIER_EMAIL_TEMPLATE_KEYS].sort());
  });

  it('la lista de plantillas con nombre es la del catálogo de emails: una plantilla nueva no puede quedarse sin el suyo', () => {
    const catalog = readFileSync(path.join(process.cwd(), 'src', 'services', 'email', 'templates', 'catalog.ts'), 'utf8');
    const registered = [...catalog.matchAll(/register\('([A-Za-z.]+)'/g)].map((match) => match[1]!);
    expect(registered.length).toBeGreaterThan(40);
    expect([...DOSSIER_EMAIL_TEMPLATE_KEYS].sort()).toEqual([...registered].sort());
  });

  it('la descarga es una lectura del catálogo: la entidad solo la ve si la hizo quien firma hoy por ella', () => {
    expect(auditCategoryOf('dossier.downloaded')).toBe('money');
    expect(READ_ACTIONS).toContain('dossier.downloaded');
    expect(ENTITY_VISIBLE_ACTIONS).toContain('dossier.downloaded');
    expect(auditCategoryOf('api.panel_dossier_denied')).toBe('security');
  });
});
