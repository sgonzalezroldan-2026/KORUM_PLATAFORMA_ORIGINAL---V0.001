import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyring } from '@/core/security/crypto';
import { verifyPassSignature, verifyPassViewSignature } from '@/core/ticketing/qr-signature';
import type { Db } from '@/lib/db';
import { BrevoEmailProvider } from '@/services/email/brevo-email-provider';
import { EmailConfigurationError, type EmailMessage, type EmailSendError } from '@/services/email/email-provider';
import { retryDelayMs } from '@/services/email/outbox-processor';
import { isUndeliverableAddress, scrubSecrets, SECRET_MESSAGE_DEFAULT_TTL_MS, secretsExpired } from '@/services/email/outbox-secrets';
import { PreviewEmailProvider } from '@/services/email/preview-email-provider';
import { getEmailProvider } from '@/services/email/provider-factory';
import { InvalidPayloadError, secretFieldsOf, TEMPLATE_CATALOG } from '@/services/email/templates/catalog';
import { renderEmail, UnknownTemplateError, type RenderEmailInput } from '@/services/email/render-email';
import { buildPublicUrl } from '@/services/email/templates/translator';
import { invalidateSettingsCache } from '@/services/settings/settings.service';

vi.mock('@/config/env', () => ({ getEnv: () => ({ PAYCOMET_MODE: process.env.PAYCOMET_MODE ?? 'mock' }) }));

const QR_SECRET = 'unit-qr-hmac-secret-0123456789-abcdefghij';
const APP_URL = 'https://korum.test';
const LOCALES = ['es', 'ca', 'en'] as const;
const NOW = new Date('2026-11-04T10:00:00.000Z');
const IN_3_DAYS = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();
const PASS_UUID = randomUUID();

const ORGANIZATION = { name: 'AMPA Colegio Sol', legalName: 'AMPA del Colegio Sol', slug: 'colegio-sol' };
const initiative = (ticketSubtype: 'EVENT' | 'RAFFLE' | null = null) => ({
  id: 7,
  title: 'Techar el patio',
  closesAt: new Date('2026-12-19T00:00:00.000Z'),
  goalCents: 120_000,
  raisedCents: 90_000,
  totalContributions: 48,
  ticketSubtype,
  ticketVenue: ticketSubtype ? 'Salón de actos' : null
});

/** Un payload válido por plantilla. Si se añade una plantilla al catálogo sin ejemplo aquí, el test de cobertura falla. */
const SAMPLES: Record<string, unknown> = {
  'auth.magicLink': { url: 'https://korum.test/auth/verify?t=abc123', minutes: 15 },
  'auth.invitation': { url: 'https://korum.test/invitacion#t=abc.def', hours: 72, organizationName: 'CEIP Cervantes', roleLabel: 'Presidencia del AFA' },
  'auth.otp': { code: '123456', minutes: 10 },
  'contribution.receipt': { initiativeId: 7, amountCents: 2_500, guaranteeCents: 150, totalCents: 2_650, reference: 'KOR-2026-0001', groupName: '3º de Primaria', fiscalCertificate: true },
  'ticket.pass': { passUuid: PASS_UUID, serialCode: 'PASE-2026-000012', initiativeId: 7, quantity: 2, raffleNumbers: [] },
  'gate.pinRevoked': { initiativeId: 7 },
  'raffle.extraRound': { initiativeId: 7, round: 2, prizes: 1, reason: 'PRIZE_UNCLAIMED' },
  'initiative.goalReached': { initiativeId: 7 },
  'initiative.expired': { initiativeId: 7, walletEscrowId: 'WLT-ESC-007', raisedCents: 90_000, goalCents: 120_000 },
  'refund.issued': { initiativeId: 7, amountCents: 2_650 },
  'doubleCheck.pending': { targetType: 'IDEA_APPROVAL', targetTitle: 'Techar el patio', token: 'T'.repeat(43), otp: '654321', expiresAt: IN_3_DAYS },
  'split.windowExpiring': { initiativeId: 7, walletEscrowId: 'WLT-ESC-007', daysLeft: 15 },
  'split.windowExpired': { initiativeId: 7, walletEscrowId: 'WLT-ESC-007', daysLeft: -2 },
  'sponsor.renewalNotice': { sponsorId: 3, amountCents: 25_000, badgeExpiresAt: IN_3_DAYS, expiresAt: IN_3_DAYS, token: `3.1798761600000.${'b'.repeat(64)}` },
  'sponsor.renewalLink': { sponsorId: 3, amountCents: 25_000, badgeExpiresAt: IN_3_DAYS, expiresAt: IN_3_DAYS, token: `3.1798761600000.${'b'.repeat(64)}` },
  'sponsor.renewed': { sponsorId: 4, level: 'PLATA', amountCents: 25_000, expiresAt: IN_3_DAYS, placed: ['Toldos para el patio'], order: 'KR0123456789ABCDEF', sig: 'a'.repeat(64) },
  'sponsor.reassigned': { sponsorId: 3, amountCents: 25_000, titles: ['Biblioteca de aula', 'Huerto escolar'], more: 1 },
  'sponsor.creditPool': { sponsorId: 3, amountCents: 25_000, deadline: IN_3_DAYS, manual: false },
  'tax.certificateReady': { fiscalYear: 2026 },
  'model182.reminder': { fiscalYear: 2026 },
  'privacy.inactivityNotice': { eraseOn: IN_3_DAYS },
  'account.passkeyAdded': {},
  'support.received': { ticketCode: 'TCK-7K3M9Q', rectification: true, answeredBy: 'SUPERADMIN' },
  'support.replied': { ticketCode: 'TCK-7K3M9Q', organization: 'CEIP Cervantes' },
  'pledge.charged': { initiativeId: 1, amountCents: 1_000, feeCents: 25, totalCents: 1_025, reference: 'KH0123456789ABCDEF', cycle: 2, totalMonths: 9, fiscalCertificate: true },
  'pledge.skipped': { amountCents: 1_000, cycle: 3, totalMonths: 9 },
  'pledge.failed': { amountCents: 1_000, cycle: 4, reason: 'CHARGE_FAILED' },
  'idea.quorumReached': { ideaId: 503, alias: '#FAM-4821', ideaTitle: 'Toldos para el patio' },
  'idea.centerReplied': { ideaId: 503, alias: '#FAM-4821', kind: 'REPLY' },
  'sponsor.welcome': { sponsorId: 3, level: 'ORO', matching: true, expiresAt: IN_3_DAYS, order: 'KS0123456789ABCDEF', sig: 'a'.repeat(64) },
  'sponsor.rejected': { sponsorId: 3, reason: 'Ya tenemos una panadería patrocinando esta campaña.', refundCents: 29_538, rectified: true, order: 'KS0123456789ABCDEF', sig: 'a'.repeat(64) },
  'signer.handover': { stage: 'REQUESTED', role: 'COSIGNER', roleLabel: 'Tesorería del AMPA', leaving: true },
  // Fondo de actividades e invitación a renovar (Sprint 4.2f).
  'sponsor.renewalInvite': { sponsorId: 3, amountCents: 25_000, badgeExpiresAt: IN_3_DAYS, expiresAt: IN_3_DAYS, token: `3.1798761600000.${'b'.repeat(64)}` },
  'sponsor.toEntityFund': { sponsorId: 3, amountCents: 25_000 },
  'sponsor.awaitingDecision': { sponsorId: 3, amountCents: 25_000, deadline: IN_3_DAYS },
  'sponsor.lateReceived': { sponsorId: 3, amountCents: 25_000 },
  'activityFund.received': { amountCents: 25_000, deadline: IN_3_DAYS },
  'activityFund.reminder': { amountCents: 25_000, deadline: IN_3_DAYS },
  'activityFund.paid': { payoutId: 4, amountCents: 25_000 },
  // Liquidación de campañas y avisos a quienes aportaron (Sprint 4.4a).
  'payout.executed': { initiativeId: 7, payoutId: 12, amountCents: 561_000, destinationType: 'PROVIDER' },
  'payout.changed': { initiativeId: 7, payoutId: 12 },
  'initiative.goalReachedSupporter': { initiativeId: 7, walletEscrowId: 'WLT-ESC-007' },
  'initiative.achievementPhotos': { initiativeId: 7, walletEscrowId: 'WLT-ESC-007' },
  // Campañas vencidas: decisión, votación de redimensionamiento, resultado y aviso de reembolso (Sprint 4.4b).
  'initiative.expiredDecided': { initiativeId: 7, decision: 'RESIZE_VOTE', closesAt: IN_3_DAYS },
  'initiative.resizeClosed': { initiativeId: 7, outcome: 'PROJECT', newGoalCents: 210_000, option: 'Comprar 14 tablets con lo recaudado' },
  'initiative.resizePoll': { initiativeId: 7, walletEscrowId: 'WLT-ESC-007', pollId: 3, closesAt: IN_3_DAYS, voteToken: '3.41.' + 'a'.repeat(64) },
  'initiative.resizeResult': { initiativeId: 7, walletEscrowId: 'WLT-ESC-007', option: 'Comprar 14 tablets con lo recaudado', newGoalCents: 210_000 },
  'initiative.refundingSupporter': { initiativeId: 7, walletEscrowId: 'WLT-ESC-007' }
};

const render = (templateKey: string, locale: (typeof LOCALES)[number], overrides: Partial<RenderEmailInput> = {}) =>
  renderEmail({ templateKey, locale, payload: SAMPLES[templateKey], createdAt: NOW, appUrl: APP_URL, organization: ORGANIZATION, initiative: initiative(), qrSecret: QR_SECRET, ...overrides });

describe('QA-NOT01 · catálogo de plantillas en es / ca / en', () => {
  it('cada plantilla del catálogo tiene su ejemplo, y todas las claves del catálogo se pueden componer', () => {
    expect([...TEMPLATE_CATALOG.keys()].sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it.each([...Object.keys(SAMPLES)])('%s se compone en los tres idiomas con HTML, texto plano y un único botón', async (templateKey) => {
    for (const locale of LOCALES) {
      const email = await render(templateKey, locale);
      expect(email.subject.trim(), `${templateKey}:${locale} asunto`).not.toBe('');
      expect(email.html).toContain(`<html lang="${locale}"`);
      for (const output of [email.subject, email.html, email.text]) {
        expect(output, `${templateKey}:${locale}`).not.toMatch(/\bundefined\b|\[object|\bNaN\b|__MISSING__|\{[a-z]+\}/);
        expect(output, `${templateKey}:${locale} vocabulario prohibido`).not.toMatch(/\bpropinas?\b|\bbanco\b|\bescrow\b|\btip\b/i);
      }
      // Regla del catálogo: un único botón principal, y su enlace también va en el texto plano.
      expect(email.html.match(/display:inline-block/g)?.length ?? 0, `${templateKey}:${locale} botones`).toBeLessThanOrEqual(1);
      const link = /href="(https:\/\/korum\.test[^"]*)" style="display:inline-block/.exec(email.html)?.[1]?.replaceAll('&amp;', '&');
      if (link) expect(email.text).toContain(link);
      expect(email.text).toContain('PAYCOMET');
    }
  });

  it('los importes y fechas siguen el idioma (25,00 € en es y ca; €25.00 en en)', async () => {
    expect((await render('contribution.receipt', 'es')).text).toContain('25,00');
    expect((await render('contribution.receipt', 'ca')).text).toContain('25,00');
    const en = (await render('contribution.receipt', 'en')).text;
    expect(en).toContain('€25.00');
    expect(en).not.toContain('25,00');
  });

  it('los enlaces llevan el prefijo del idioma: el castellano sin él, /ca y /en con él', async () => {
    const urlOf = async (locale: (typeof LOCALES)[number]) => /(https:\/\/korum\.test\/\S+)/.exec((await render('contribution.receipt', locale)).text)?.[1] ?? '';
    expect(await urlOf('es')).toContain('https://korum.test/colegio-sol/iniciativas/7');
    expect(await urlOf('ca')).toContain('https://korum.test/ca/colegio-sol/iniciativas/7');
    expect(await urlOf('en')).toContain('https://korum.test/en/colegio-sol/iniciativas/7');
    expect(buildPublicUrl('https://korum.test/', 'es', 'login')).toBe('https://korum.test/login');
  });

  it('el recibo habla del certificado fiscal solo si la entidad tiene la Ley 49/2002 verificada; si no, de justificante nominativo', async () => {
    const withLaw = await render('contribution.receipt', 'es');
    expect(withLaw.text).toContain('certificado fiscal');
    const without = await render('contribution.receipt', 'es', { payload: { ...(SAMPLES['contribution.receipt'] as object), fiscalCertificate: false } });
    expect(without.text).toContain('justificante nominativo');
    expect(without.text).not.toContain('certificado fiscal');
  });

  it('idea.centerReplied nunca copia el mensaje; al publicar la idea avisa si la entidad corrigió el texto (Sprint 4.2a)', async () => {
    const approved = await render('idea.centerReplied', 'es', { payload: { ideaId: 503, alias: '#FAM-4821', kind: 'APPROVED', edited: true } });
    expect(approved.subject).toBe('Tu propuesta ya recoge firmas en AMPA Colegio Sol');
    expect(approved.text).toContain('La entidad ha corregido el texto al publicarla.');
    expect((await render('idea.centerReplied', 'en', { payload: { ideaId: 503, alias: '#FAM-4821', kind: 'APPROVED', edited: false } })).text).not.toContain('edited the text');
    const rejected = await render('idea.centerReplied', 'ca', { payload: { ideaId: 503, alias: '#FAM-4821', kind: 'REJECTED' } });
    expect(rejected.text).toContain('/ca/mi-cuenta/propuestas');
  });

  it('sponsor.welcome lleva un solo botón al cartel con el enlace firmado del pedido; la firma es un secreto que se borra al enviar (Sprint 4.2b)', async () => {
    const email = await render('sponsor.welcome', 'es');
    expect(email.subject).toBe('¡Ya eres Comercio amigo de AMPA Colegio Sol!');
    expect(email.text).toContain('Tu bolsa Matching 2x ya está activa');
    expect(email.text).toContain(`https://korum.test/colegio-sol/comercios/documentos/justificante?pedido=KS0123456789ABCDEF&sig=${'a'.repeat(64)}`);
    expect(secretFieldsOf('sponsor.welcome')).toEqual(['sig']);
    const withoutPool = await render('sponsor.welcome', 'ca', { payload: { ...(SAMPLES['sponsor.welcome'] as object), matching: false, level: 'BRONCE' } });
    expect(withoutPool.text).not.toContain('Matching');
    expect(withoutPool.text).toContain('Bronze');
  });

  it('sponsor.rejected copia el motivo del centro, dice cuánto se devuelve y enlaza la rectificativa solo si existe (Sprint 4.2b)', async () => {
    const email = await render('sponsor.rejected', 'es');
    expect(email.text).toContain('«Ya tenemos una panadería patrocinando esta campaña.»');
    expect(email.text).toContain('295,38');
    expect(email.text).toContain('/colegio-sol/comercios/documentos/rectificativa?pedido=');
    const noInvoice = await render('sponsor.rejected', 'en', { payload: { ...(SAMPLES['sponsor.rejected'] as object), rectified: false } });
    expect(noInvoice.text).toContain('/en/colegio-sol/comercios/documentos/justificante?pedido=');
    expect(noInvoice.text).not.toContain('corrective invoice');
    expect(secretFieldsOf('sponsor.rejected')).toEqual(['sig']);
  });

  it('signer.handover pide el visto bueno sin nombres ni emails de nadie y lleva al equipo que firma; al completarse distingue a quien sale (Sprint 4.2e)', async () => {
    const requested = await render('signer.handover', 'es');
    expect(requested.subject).toBe('AMPA Colegio Sol: te proponen un relevo en tu puesto de firma');
    expect(requested.text).toContain('https://korum.test/panel/colegio-sol/ajustes#equipo');
    expect(requested.text).not.toMatch(/@/);
    const leaving = await render('signer.handover', 'ca', { payload: { stage: 'COMPLETED', role: 'DIRECTOR', roleLabel: 'Direcció del centre', leaving: true } });
    expect(leaving.subject).toContain('ja no signes');
    expect(leaving.text).toContain('Direcció del centre');
    const staying = await render('signer.handover', 'en', { payload: { stage: 'COMPLETED', role: 'COSIGNER', roleLabel: 'Treasurer', leaving: false } });
    expect(staying.subject).toContain('new person on the signing team');
    expect((await render('signer.handover', 'es', { payload: { stage: 'DECLINED', role: 'COSIGNER', roleLabel: 'Tesorería', leaving: false } })).text).toContain('Relevo rechazado');
  });

  it('la aportación voluntaria a KORUM solo aparece en el recibo si se marcó', async () => {
    const without = await render('contribution.receipt', 'es', { payload: { ...(SAMPLES['contribution.receipt'] as object), guaranteeCents: 0, totalCents: 2_500 } });
    expect(without.text).not.toContain('Aportación voluntaria');
    expect((await render('contribution.receipt', 'es')).text).toContain('Aportación voluntaria a KORUM');
  });

  it('el remitente es «{Entidad} vía KORUM» en el idioma de la persona; sin entidad no hay nombre propio', async () => {
    expect((await render('contribution.receipt', 'es')).senderName).toBe('AMPA Colegio Sol vía KORUM');
    expect((await render('contribution.receipt', 'ca')).senderName).toBe('AMPA Colegio Sol via KORUM');
    expect((await render('auth.otp', 'es', { organization: undefined, initiative: undefined })).senderName).toBeUndefined();
  });
});

describe('QA-NOT01 · entradas y papeletas', () => {
  it('la entrada adjunta el QR firmado como PNG y un .ics de día completo; el QR firmado no va en el HTML', async () => {
    const email = await render('ticket.pass', 'es', { initiative: initiative('EVENT') });
    const [qr, calendar] = email.attachments;
    expect(qr?.filename).toBe('PASE-2026-000012.png');
    expect(Buffer.from(qr!.contentBase64, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(calendar?.filename).toBe('PASE-2026-000012.ics');
    const ics = Buffer.from(calendar!.contentBase64, 'base64').toString('utf8');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261219');
    expect(ics).toContain('SUMMARY:Techar el patio');
    expect(ics).toContain('LOCATION:Salón de actos');
    expect(email.html).not.toContain('korum://v1/pass');
    expect(email.text).not.toContain('korum://v1/pass');
  });

  it('el botón lleva al invitado a su pase con una firma que solo valida ese pase', async () => {
    const email = await render('ticket.pass', 'es', { initiative: initiative('EVENT') });
    const url = new URL(/(https:\/\/korum\.test\/colegio-sol\/entrada\/[^\s]+)/.exec(email.text)![1]!);
    const signature = url.searchParams.get('sig')!;
    expect(url.pathname).toBe(`/colegio-sol/entrada/${PASS_UUID}`);
    expect(verifyPassViewSignature(QR_SECRET, PASS_UUID, signature)).toBe(true);
    expect(verifyPassViewSignature(QR_SECRET, randomUUID(), signature)).toBe(false);
    // El enlace queda en registros y en el Referer: su firma no sirve para rehacer el QR que abre la puerta.
    expect(verifyPassSignature(QR_SECRET, PASS_UUID, signature)).toBe(false);
  });

  it('una rifa lleva sus números y no adjunta calendario', async () => {
    const email = await render('ticket.pass', 'ca', { initiative: initiative('RAFFLE'), payload: { ...(SAMPLES['ticket.pass'] as object), raffleNumbers: [12, 13] } });
    expect(email.text).toContain('12, 13');
    expect(email.attachments.map((file) => file.filename)).toEqual(['PASE-2026-000012.png']);
    expect(email.subject).toContain('butlletes');
  });

  it('sin QR_HMAC_SECRET no se puede componer la entrada: falla en lugar de enviar un email sin QR', async () => {
    await expect(render('ticket.pass', 'es', { initiative: initiative('EVENT'), qrSecret: undefined })).rejects.toThrow(/QR_HMAC_SECRET/);
  });
});

describe('QA-NOT01 · firma pendiente y datos de un solo uso', () => {
  it('el enlace de firma lleva el token en el fragmento (#), que el navegador no envía al servidor, y el código en el cuerpo', async () => {
    const email = await render('doubleCheck.pending', 'es');
    expect(email.text).toContain(`/panel/colegio-sol/firmar#t=${'T'.repeat(43)}`);
    expect(email.text).toContain('654321');
    expect(email.text).not.toMatch(/\?t=|\?token=/);
  });

  it('el código de un solo uso se pinta grande y aparte de los datos, y también va en el texto plano', async () => {
    for (const templateKey of ['auth.otp', 'doubleCheck.pending'] as const) {
      const email = await render(templateKey, 'es');
      const code = (SAMPLES[templateKey] as { code?: string; otp?: string }).code ?? (SAMPLES[templateKey] as { otp: string }).otp;
      expect(email.html).toMatch(new RegExp(`font-size:36px[^>]*>${code}<`));
      expect(email.text).toContain(code);
    }
  });

  it('el pie dice la verdad de cada destinatario: operación propia, gestión de la entidad o acción sobre la cuenta', async () => {
    expect((await render('contribution.receipt', 'es')).text).toContain('has hecho una operación en AMPA Colegio Sol');
    for (const templateKey of ['gate.pinRevoked', 'raffle.extraRound', 'initiative.goalReached', 'initiative.expired', 'split.windowExpiring', 'split.windowExpired', 'model182.reminder', 'doubleCheck.pending']) {
      const text = (await render(templateKey, 'es')).text;
      expect(text, templateKey).toContain('gestionas AMPA Colegio Sol en KORUM');
      expect(text, templateKey).not.toContain('has hecho una operación');
    }
    expect((await render('auth.otp', 'ca')).text).toContain('T’escrivim');
  });

  it('el aviso de una ronda extra dice quién la hizo, qué papeletas son las nuevas y cuáles sustituyen, en los tres idiomas', async () => {
    const payload = { initiativeId: 7, round: 2, prizes: 2, reason: 'PRIZE_UNCLAIMED', numbers: [3, 12], replaced: [1, 4], by: 'Carla Puig' };
    const es = (await render('raffle.extraRound', 'es', { payload })).text;
    expect(es).toContain('Carla Puig ha hecho la ronda 2');
    expect(es).toContain('#0003, #0012');
    expect(es).toContain('#0001, #0004');
    expect(es).toContain('premio sin reclamar');
    const sinNombre = (await render('raffle.extraRound', 'es', { payload: { ...payload, by: undefined } })).text;
    expect(sinNombre).toContain('Una de las personas firmantes ha hecho la ronda 2');
    expect((await render('raffle.extraRound', 'ca', { payload })).text).toContain('Carla Puig ha fet la ronda 2');
    expect((await render('raffle.extraRound', 'en', { payload })).text).toContain('Carla Puig made round 2');
  });

  it('el plazo de la firma lleva fecha y hora de Madrid, y el inglés usa fechas británicas', async () => {
    const payload = { ...(SAMPLES['doubleCheck.pending'] as object), expiresAt: '2026-11-07T22:30:00.000Z' };
    expect((await render('doubleCheck.pending', 'es', { payload })).text).toMatch(/7 de noviembre de 2026.*23:30/);
    expect((await render('ticket.pass', 'en', { initiative: initiative('EVENT') })).text).toContain('19 December 2026');
  });

  it('un payload que no cumple la forma esperada falla indicando solo los campos, nunca sus valores', async () => {
    const error = await render('doubleCheck.pending', 'es', { payload: { targetType: 'IDEA_APPROVAL', targetTitle: 'x', token: 'corto-pero-secreto', otp: 'no-es-un-codigo', expiresAt: IN_3_DAYS } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidPayloadError);
    expect((error as Error).message).toContain('token');
    expect((error as Error).message).toContain('otp');
    expect((error as Error).message).not.toContain('corto-pero-secreto');
    expect((error as Error).message).not.toContain('no-es-un-codigo');
  });

  it('una plantilla que no está en el catálogo se rechaza con un error propio', async () => {
    await expect(render('no.existe', 'es')).rejects.toBeInstanceOf(UnknownTemplateError);
  });

  it('solo se borran los campos secretos y solo de las plantillas que los tienen', () => {
    const payload = { targetType: 'IDEA_APPROVAL', targetTitle: 'Patio', token: 'T'.repeat(43), otp: '123456', expiresAt: IN_3_DAYS };
    expect(scrubSecrets('doubleCheck.pending', payload)).toEqual({ targetType: 'IDEA_APPROVAL', targetTitle: 'Patio', expiresAt: IN_3_DAYS });
    expect(scrubSecrets('auth.otp', { code: '123456', minutes: 10 })).toEqual({ minutes: 10 });
    expect(scrubSecrets('auth.magicLink', { url: 'https://korum.test/x', minutes: 15 })).toEqual({ minutes: 15 });
    expect(scrubSecrets('refund.issued', { initiativeId: 1, amountCents: 5 })).toEqual({ initiativeId: 1, amountCents: 5 });
    expect(scrubSecrets('doubleCheck.pending', {})).toEqual({});
    expect(scrubSecrets('doubleCheck.pending', null)).toBeNull();
  });

  it('un enlace o código no se envía caducado: por su fecha, o por una hora desde que se escribió si no la tiene', () => {
    const createdAt = new Date(NOW.getTime() - 2 * SECRET_MESSAGE_DEFAULT_TTL_MS);
    expect(secretsExpired({ templateKey: 'doubleCheck.pending', payloadJson: { expiresAt: IN_3_DAYS }, createdAt }, NOW)).toBe(false);
    expect(secretsExpired({ templateKey: 'doubleCheck.pending', payloadJson: { expiresAt: new Date(NOW.getTime() - 1).toISOString() }, createdAt }, NOW)).toBe(true);
    expect(secretsExpired({ templateKey: 'auth.otp', payloadJson: { code: '123456', minutes: 10 }, createdAt }, NOW)).toBe(true);
    expect(secretsExpired({ templateKey: 'auth.otp', payloadJson: { code: '123456', minutes: 10 }, createdAt: NOW }, NOW)).toBe(false);
    // Los avisos sin secretos nunca caducan por esto.
    expect(secretsExpired({ templateKey: 'refund.issued', payloadJson: {}, createdAt }, NOW)).toBe(false);
  });

  it('no se escribe a quien no tiene destinatario real (cuenta suprimida, vacío, sin @ o dominio .invalid)', () => {
    for (const address of ['', '  ', 'suprimida-u1@anonimizado.invalid', 'a@b.INVALID', 'sin-arroba']) expect(isUndeliverableAddress(address), address).toBe(true);
    for (const address of ['familia@correo.es', 'Madre.Pérez@colegio.cat']) expect(isUndeliverableAddress(address), address).toBe(false);
  });

  it('la espera entre reintentos crece y se queda en el último escalón', () => {
    const delays = [1, 2, 3, 4, 5, 6, 20].map(retryDelayMs);
    expect(delays[0]).toBe(60_000);
    for (let index = 1; index < 5; index += 1) expect(delays[index]!).toBeGreaterThan(delays[index - 1]!);
    expect(delays[5]).toBe(delays[4]);
    expect(delays[6]).toBe(delays[4]);
  });
});

describe('QA-NOT01 · adaptador de Brevo', () => {
  const message: EmailMessage = {
    to: 'familia@correo.es',
    fromAddress: 'no-responder@korum.test',
    fromName: 'AMPA Sol vía KORUM',
    replyTo: 'ayuda@korum.test',
    subject: 'Asunto',
    html: '<p>Hola</p>',
    text: 'Hola',
    attachments: [{ filename: 'PASE.png', contentType: 'image/png', contentBase64: 'AAAA' }],
    idempotencyKey: 'ticket.pass:1'
  };
  const respond = (status: number, body: unknown = {}) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  it('envía el mensaje a la API transaccional con la clave en la cabecera y devuelve el identificador del proveedor', async () => {
    const fetchImpl = respond(201, { messageId: '<abc@brevo>' });
    expect(await new BrevoEmailProvider('xkeysib-secreta-0123456789', fetchImpl).send(message)).toEqual({ providerMessageId: '<abc@brevo>' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-secreta-0123456789');
    expect(JSON.parse(String(init.body))).toMatchObject({
      sender: { name: 'AMPA Sol vía KORUM', email: 'no-responder@korum.test' },
      to: [{ email: 'familia@correo.es' }],
      replyTo: { email: 'ayuda@korum.test' },
      subject: 'Asunto',
      htmlContent: '<p>Hola</p>',
      textContent: 'Hola',
      attachment: [{ name: 'PASE.png', content: 'AAAA' }]
    });
  });

  it('un 400 es permanente; la clave rechazada, el límite, los 5xx y los cortes de red se reintentan', async () => {
    const outcome = async (fetchImpl: typeof fetch) => new BrevoEmailProvider('k'.repeat(20), fetchImpl).send(message).catch((error: unknown) => error as EmailSendError);
    expect(await outcome(respond(400))).toMatchObject({ permanent: true });
    for (const status of [429, 500, 503]) expect(await outcome(respond(status)), String(status)).toMatchObject({ permanent: false });
    // Clave revocada o remitente no autorizado: es de configuración, el mensaje espera y no gasta intentos.
    for (const status of [401, 403]) expect(await outcome(respond(status)), String(status)).toBeInstanceOf(EmailConfigurationError);
    expect(await outcome(vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch)).toMatchObject({ permanent: false });
    expect(await outcome(respond(201, {}))).toMatchObject({ permanent: false });
  });

  it('el error no repite la dirección del destinatario ni la clave', async () => {
    const error = (await new BrevoEmailProvider('xkeysib-secreta-0123456789', respond(400, { message: 'invalid familia@correo.es' })).send(message).catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain('familia@correo.es');
    expect(error.message).not.toContain('xkeysib');
  });
});

describe('QA-NOT02 · modo vista previa y elección de proveedor', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'korum-email-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    invalidateSettingsCache();
  });

  it('guarda el HTML, el texto y los adjuntos para abrirlos en el navegador, sin enviar nada', async () => {
    const provider = new PreviewEmailProvider({ directory });
    const email = await render('ticket.pass', 'es', { initiative: initiative('EVENT') });
    const { providerMessageId } = await provider.send({ to: 'familia@correo.es', fromAddress: 'a@korum.test', fromName: 'KORUM', subject: email.subject, html: email.html, text: email.text, attachments: email.attachments, idempotencyKey: 'ticket.pass:9' });
    expect(providerMessageId).toMatch(/^preview-[0-9a-f]{16}$/);
    expect((await readdir(directory)).sort()).toEqual([`${providerMessageId}-PASE-2026-000012.ics`, `${providerMessageId}-PASE-2026-000012.png`, `${providerMessageId}.html`, `${providerMessageId}.txt`]);
    expect(await readFile(path.join(directory, `${providerMessageId}.txt`), 'utf8')).toContain('Para: familia@correo.es');
    expect(provider.sent).toHaveLength(1);
  });

  const fakeDb = (settings: Record<string, unknown>) =>
    ({ platformSetting: { findUnique: async ({ where }: { where: { key: string } }) => (where.key in settings ? { valueJson: settings[where.key] } : null) }, platformSecret: { findUnique: async () => null } }) as unknown as Db;
  const KEYRING = createKeyring({ version: 1, key: Buffer.alloc(32, 7).toString('base64') });

  it('con PAYCOMET_MODE=mock siempre es la vista previa: un entorno con cobros simulados nunca envía emails reales', async () => {
    vi.stubEnv('PAYCOMET_MODE', 'mock');
    expect((await getEmailProvider(fakeDb({ 'email.provider': 'brevo' }), KEYRING)).name).toBe('preview');
  });

  it('con sandbox o live exige el proveedor y su clave; sin ellos lanza un error de configuración, no pierde mensajes', async () => {
    vi.stubEnv('PAYCOMET_MODE', 'sandbox');
    vi.stubEnv('EMAIL_API_KEY', '');
    await expect(getEmailProvider(fakeDb({ 'email.provider': 'brevo' }), KEYRING)).rejects.toBeInstanceOf(EmailConfigurationError);
    invalidateSettingsCache();
    vi.stubEnv('EMAIL_API_KEY', 'xkeysib-de-respaldo-0123456789');
    expect((await getEmailProvider(fakeDb({ 'email.provider': 'brevo' }), KEYRING)).name).toBe('brevo');
    invalidateSettingsCache();
    await expect(getEmailProvider(fakeDb({ 'email.provider': 'smtp' }), KEYRING)).rejects.toBeInstanceOf(EmailConfigurationError);
  });
});

describe('vista previa local de todas las plantillas', () => {
  /**
   * Para revisar a ojo cómo queda cada email: `EMAIL_PREVIEW=1 npx vitest run tests/unit/email-outbox.spec.ts` (en PowerShell:
   * `$env:EMAIL_PREVIEW=1; npx vitest run tests/unit/email-outbox.spec.ts`) deja un `.html` y un `.txt` por plantilla e idioma en
   * `.email-preview/` (carpeta ignorada por git). Sin la variable, esta prueba no hace nada.
   */
  it.runIf(process.env.EMAIL_PREVIEW === '1')('escribe .email-preview/{plantilla}.{idioma}.html y .txt', async () => {
    const directory = path.join(process.cwd(), '.email-preview');
    await mkdir(directory, { recursive: true });
    for (const templateKey of Object.keys(SAMPLES)) {
      for (const locale of LOCALES) {
        const email = await render(templateKey, locale, { initiative: initiative(templateKey === 'ticket.pass' ? 'EVENT' : null) });
        const name = `${templateKey}.${locale}`;
        await writeFile(path.join(directory, `${name}.html`), email.html, 'utf8');
        await writeFile(path.join(directory, `${name}.txt`), `Asunto: ${email.subject}

${email.text}`, 'utf8');
        for (const attachment of email.attachments) await writeFile(path.join(directory, `${name}-${attachment.filename}`), Buffer.from(attachment.contentBase64, 'base64'));
      }
    }
    expect((await readdir(directory)).filter((file) => file.endsWith('.html'))).toHaveLength(Object.keys(SAMPLES).length * LOCALES.length);
  });
});
