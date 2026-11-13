import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '@/config/env';
import { renderPersonalDataPdf, type ExportTranslator } from '@/core/privacy/export-pdf';
import type { PersonalDataExport } from '@/core/privacy/personal-data-export';
import { oneMonthAfter } from '@/core/privacy/privacy-requests';
import { fiscalCutoff, lastExpiredFiscalYear } from '@/core/privacy/retention-policy';
import { createKeyring, CRYPTO_CONTEXT, DecryptionError, KeyringConfigurationError, keyringFromEnv, needsRotation, openParts, openValue, parsePreviousKeys, sealParts, sealValue, secretHint } from '@/core/security/crypto';
import { SuperadminRequiredError } from '@/core/security/superadmin-guard';
import { assertVerifiedSuperadmin, type VerifiedSuperadminActor } from '@/core/security/verified-actor';
import { openSponsorTaxId, sealDonorTaxId, sealInvoiceRecipientTaxId, openInvoiceRecipientTaxId, sealSponsorTaxId } from '@/core/tax/tax-id-vault';
import { isSensitiveKey, REDACTED, sanitizeAuditMetadata } from '@/services/audit/audit.service';
import { settingDefinition, UnknownSettingError, secretDefinition } from '@/services/settings/setting-definitions';
import es from '../../messages/es.json';

/** Sprint 2.5 · QA-SEC07, QA-PRIV01, QA-PRIV02 y QA-REG03 (partes sin base de datos). */

const key = () => randomBytes(32).toString('base64');
const K1 = key();
const K2 = key();
const v1 = createKeyring({ version: 1, key: K1 });
const v2WithPrevious = createKeyring({ version: 2, key: K2 }, [{ version: 1, key: K1 }]);

describe('crypto.ts · AES-256-GCM con versión de clave y contexto', () => {
  it('cifra y descifra; el texto cifrado no contiene el valor y cambia en cada cifrado', () => {
    const first = sealValue(v1, '12345678Z', CRYPTO_CONTEXT.donorTaxId);
    const second = sealValue(v1, '12345678Z', CRYPTO_CONTEXT.donorTaxId);
    expect(first.keyVersion).toBe(1);
    expect(first.sealed).not.toContain('12345678Z');
    expect(first.sealed).not.toBe(second.sealed);
    expect(openValue(v1, first.sealed, 1, CRYPTO_CONTEXT.donorTaxId)).toBe('12345678Z');
  });

  it('un valor copiado a otro contexto (otra fila, otra entidad, otra factura) no se descifra', () => {
    const card = sealValue(v1, 'token-de-la-tarjeta', CRYPTO_CONTEXT.cardTokenUser(1));
    expect(() => openValue(v1, card.sealed, 1, CRYPTO_CONTEXT.cardTokenUser(2))).toThrow(DecryptionError);
    const cif = sealSponsorTaxId(v1, 'org-a', 'B12345674');
    expect(() => openSponsorTaxId(v1, { organizationId: 'org-b', cifEnc: cif.cifEnc, cifKeyVersion: cif.cifKeyVersion })).toThrow(DecryptionError);
    const invoice = sealInvoiceRecipientTaxId(v1, 'FAC-2031-0001', 'b-12.345.674');
    expect(openInvoiceRecipientTaxId(v1, { invoiceNumber: 'FAC-2031-0001', ...invoice })).toBe('B12345674');
    expect(() => openInvoiceRecipientTaxId(v1, { invoiceNumber: 'FAC-2031-0002', ...invoice })).toThrow(DecryptionError);
  });

  it('durante una rotación se lee lo cifrado con la clave anterior y se cifra con la nueva', () => {
    const old = sealParts(v1, 'clave-api-de-paycomet', CRYPTO_CONTEXT.platformSecret('paycomet.apiKey'));
    expect(openParts(v2WithPrevious, old, CRYPTO_CONTEXT.platformSecret('paycomet.apiKey'))).toBe('clave-api-de-paycomet');
    expect(sealValue(v2WithPrevious, 'x', 'c').keyVersion).toBe(2);
    expect(needsRotation(v2WithPrevious, 1)).toBe(true);
    expect(needsRotation(v2WithPrevious, null)).toBe(true);
    expect(needsRotation(v2WithPrevious, 2)).toBe(false);
  });

  it('subir solo el número de versión, sin cambiar la clave, no deja nada sin leer', () => {
    const bumped = createKeyring({ version: 2, key: K1 });
    const sealed = sealValue(v1, 'valor', 'contexto');
    expect(openValue(bumped, sealed.sealed, 1, 'contexto')).toBe('valor');
  });

  it('sin la clave correcta falla de forma explícita, nunca devuelve basura', () => {
    const sealed = sealValue(v1, 'valor', 'contexto');
    const other = createKeyring({ version: 3, key: K2 });
    expect(() => openValue(other, sealed.sealed, 1, 'contexto')).toThrow(DecryptionError);
    expect(() => openValue(v1, 'mal.formado', 1, 'contexto')).toThrow(DecryptionError);
    // El mensaje no lleva el contexto completo (puede incluir un identificador): solo su tipo.
    expect(() => openValue(other, sealed.sealed, 1, CRYPTO_CONTEXT.userTaxId('usuario-123'))).toThrow(/«user»/);
  });

  it('el llavero rechaza claves mal formadas, versiones repetidas y claves anteriores más nuevas que la actual', () => {
    expect(() => createKeyring({ version: 1, key: 'corta' })).toThrow(KeyringConfigurationError);
    expect(() => createKeyring({ version: 0, key: K1 })).toThrow(KeyringConfigurationError);
    expect(() => createKeyring({ version: 2, key: K2 }, [{ version: 2, key: K1 }])).toThrow(/repetida/);
    expect(() => createKeyring({ version: 2, key: K2 }, [{ version: 3, key: K1 }])).toThrow(/más nueva/);
    expect(parsePreviousKeys(undefined)).toEqual([]);
    expect(parsePreviousKeys(' ')).toEqual([]);
    expect(parsePreviousKeys(`1:${K1}, 2:${K2}`)).toEqual([{ version: 1, key: K1 }, { version: 2, key: K2 }]);
    expect(() => parsePreviousKeys(K1)).toThrow(KeyringConfigurationError);
    expect(keyringFromEnv({ ENCRYPTION_KEY: K2, ENCRYPTION_KEY_VERSION: 2, ENCRYPTION_PREVIOUS_KEYS: `1:${K1}` }).keys.size).toBe(2);
  });

  it('el entorno valida las claves anteriores al arrancar', () => {
    const base = { DATABASE_URL: 'postgresql://korum:korum@localhost:5432/korum', BETTER_AUTH_SECRET: key(), ENCRYPTION_KEY: K2, ENCRYPTION_KEY_VERSION: '2', DATA_HMAC_SECRET: key(), QR_HMAC_SECRET: key(), CRON_SECRET: key() };
    expect(parseEnv({ ...base, ENCRYPTION_PREVIOUS_KEYS: `1:${K1}` }).ENCRYPTION_PREVIOUS_KEYS).toBe(`1:${K1}`);
    expect(() => parseEnv({ ...base, ENCRYPTION_PREVIOUS_KEYS: '1:no-es-una-clave' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...base, ENCRYPTION_PREVIOUS_KEYS: `3:${K1}` })).toThrow(/ENCRYPTION_PREVIOUS_KEYS/);
  });

  it('la pista de un secreto son sus 4 últimos caracteres, y ninguna si es corto', () => {
    expect(secretHint('sk_live_0123456789abcd')).toBe('abcd');
    expect(secretHint('corto')).toBeNull();
    // Con menos de 20 caracteres (una contraseña de 12 enseñaría un tercio) no se enseña nada.
    expect(secretHint('contraseña-1234')).toBeNull();
    expect(secretHint('x'.repeat(19))).toBeNull();
    expect(secretHint(`${'x'.repeat(16)}abcd`)).toBe('abcd');
  });

  it('el NIF del donante se valida y su HMAC no depende de la clave de cifrado', () => {
    const hmacSecret = 'secreto-hmac-de-pruebas-de-32-caracteres';
    expect(() => sealDonorTaxId('12345678A', { keyring: v1, hmacSecret })).toThrow(RangeError);
    const a = sealDonorTaxId('12345678z', { keyring: v1, hmacSecret });
    const b = sealDonorTaxId('12345678Z', { keyring: v2WithPrevious, hmacSecret });
    expect(a.donorTaxIdHmac).toBe(b.donorTaxIdHmac);
    expect(b.donorTaxIdKeyVersion).toBe(2);
  });
});

describe('VerifiedSuperadminActor · no se puede fabricar', () => {
  it('un objeto escrito a mano con la misma forma se rechaza', () => {
    const forged = { kind: 'verified-superadmin', userId: 'admin', sessionId: 's', secondFactorVerifiedAt: new Date() } as VerifiedSuperadminActor;
    expect(() => assertVerifiedSuperadmin(forged, 'settings.update')).toThrow(SuperadminRequiredError);
    expect(() => assertVerifiedSuperadmin(forged, 'settings.update')).toThrow(/sesión no es válida/);
  });
});

describe('catálogo de ajustes · validación por clave', () => {
  it('una clave que no está en el catálogo no se puede leer ni guardar', () => {
    expect(() => settingDefinition('paycomet.merchantcode')).toThrow(UnknownSettingError);
    expect(() => secretDefinition('paycomet.apikey')).toThrow(UnknownSettingError);
    expect(() => settingDefinition('legal.terminos.fr')).toThrow(UnknownSettingError);
  });

  it('cada clave valida su valor', () => {
    const ok = (name: string, value: unknown) => settingDefinition(name).schema.safeParse(value).success;
    expect(ok('paycomet.serverIp', '203.0.113.7')).toBe(true);
    expect(ok('paycomet.serverIp', '2001:db8::1')).toBe(true);
    expect(ok('paycomet.serverIp', '300.1.1.1')).toBe(false);
    expect(ok('paycomet.terminalId', '12345')).toBe(true);
    expect(ok('paycomet.terminalId', '12a')).toBe(false);
    expect(ok('invoicing.issuerNif', 'B12345674')).toBe(true);
    expect(ok('invoicing.issuerNif', 'B12345678')).toBe(false);
    expect(ok('hucha.mode', 'REGULATED_WALLET')).toBe(true);
    expect(ok('hucha.mode', 'WALLET')).toBe(false);
    expect(ok('limits.gatePinMaxFailures', 20)).toBe(true);
    expect(ok('limits.gatePinMaxFailures', 0)).toBe(false);
    expect(ok('legal.privacidad.ca', { version: '2026-11-05', status: 'BORRADOR', markdown: '# Política' })).toBe(true);
    expect(ok('legal.privacidad.ca', { version: 'v1', status: 'BORRADOR', markdown: '# Política' })).toBe(false);
  });

  it('los valores por defecto coinciden con DECISIONES_TECNICAS §6', () => {
    expect(settingDefinition('hucha.mode').defaultValue).toBe('PLEDGE');
    expect(settingDefinition('email.provider').defaultValue).toBe('brevo');
    expect(settingDefinition('autoBoost.publicDisclosureDefault').defaultValue).toBe('SHOW');
    expect(settingDefinition('paycomet.merchantCode').envFallback).toBe('PAYCOMET_MERCHANT_CODE');
    expect(secretDefinition('paycomet.webhookSecret').envFallback).toBe('PAYCOMET_WEBHOOK_SECRET');
  });
});

describe('auditoría sin datos sensibles', () => {
  it('reconoce los nombres de campo sensibles sin confundir los técnicos', () => {
    for (const name of ['email', 'guestEmail', 'donorTaxId', 'nif', 'iban', 'tokenUser', 'password', 'otp', 'phone', 'fullName', 'ipHash', 'userAgent', 'newValue', 'contraseña', 'names', 'fullname', 'surname', 'apellidos', 'addresses', 'holders', 'apikey', 'apiKey', 'emails', 'taxIds']) expect(isSensitiveKey(name), name).toBe(true);
    for (const name of ['key', 'version', 'keyVersion', 'templateKey', 'passUuid', 'fiscalYear', 'amountCents', 'reason', 'attempted', 'newSetting']) expect(isSensitiveKey(name), name).toBe(false);
  });

  it('sustituye los valores sensibles y limpia los textos, también en objetos anidados', () => {
    const clean = sanitizeAuditMetadata({ key: 'paycomet.apiKey', value: 'sk_live_secreto', nested: { email: 'ana@example.com', note: 'escribió ana@example.com con NIF 12345678Z' }, list: [{ iban: 'ES9121000418450200051332' }], count: 3 }) as Record<string, unknown>;
    expect(clean.key).toBe('paycomet.apiKey');
    expect(clean.value).toBe(REDACTED);
    expect(clean.count).toBe(3);
    expect(JSON.stringify(clean)).not.toMatch(/ana@example\.com|12345678Z|ES9121|sk_live/);
  });

  it('acota la profundidad y la longitud', () => {
    const deep = sanitizeAuditMetadata({ a: { b: { c: { d: { e: 'x' } } } } }) as { a: { b: { c: { d: unknown } } } };
    expect(deep.a.b.c.d).toBe(REDACTED);
    expect(String(sanitizeAuditMetadata('x'.repeat(5000))).length).toBeLessThan(400);
    // Un email justo en el límite del recorte no queda a medias: se limpia antes de recortar.
    expect(String(sanitizeAuditMetadata(`${'a'.repeat(290)} ana.garcia@example.com`))).not.toContain('ana.gar');
  });
});

/** Traductor sencillo sobre el catálogo castellano, como hará next-intl en la ruta (Sprint 3.7). */
const translate: ExportTranslator = (path, values = {}) => {
  const text = path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], es.privacy.export);
  return typeof text === 'string' ? text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '') : path;
};

function sampleExport(contributions = 1): PersonalDataExport {
  return {
    formatVersion: 1,
    generatedAt: '2026-11-05T10:00:00.000Z',
    account: { id: 'u1', name: 'Núria (Pàrraga) \\ Ibáñez', email: 'nuria@example.com', locale: 'ca', emailVerified: true, twoFactorEnabled: false, taxId: '12345678Z', provinceCode: '08', postalCode: '08001', createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-11-01T00:00:00.000Z' },
    contributions: Array.from({ length: contributions }, (_, index) => ({
      id: index + 1, createdAt: '2026-10-01T09:00:00.000Z', organization: 'AFA Escola', initiative: 'Toldos del pati', type: 'DONATION', status: 'COMPLETED', paymentMethod: 'BIZUM',
      amountCents: 2500, guaranteeContributionCents: 200, totalChargedCents: 2700, refundedCents: 0, group: '3º de Primaria', donorFullName: 'Núria', donorTaxId: '12345678Z', donorProvinceCode: '08', asGuest: false
    })),
    tickets: [], consents: [{ purpose: 'DEVICE_FINGERPRINT', granted: false, policyVersion: '2026-11-05', source: 'cuenta', createdAt: '2026-11-02T00:00:00.000Z' }],
    privacyRequests: [], memberships: [], ideaSignatures: [], ideaProposals: [{ alias: "#FAM-4821", title: "Toldo en el patio", category: "Patio", description: "Falta sombra en el patio de infantil.", phase: "PUBLIC_VOTING", createdAt: "2026-11-01T10:00:00.000Z", messages: [{ from: "#FAM-4821", body: "Hola, ¿se ha visto?", createdAt: "2026-11-02T10:00:00.000Z" }] }], devices: [], savedCards: [], passkeys: [{ name: "Móvil de casa", createdAt: "2026-11-01T10:00:00.000Z", deviceType: "multiDevice", synced: true }], monthlyPledges: [],
    notifications: [{ template: 'contribution.receipt', status: 'SENT', createdAt: '2026-10-01T09:01:00.000Z', sentAt: '2026-10-01T09:01:05.000Z' }],
    supportTickets: [], unreadableTaxIds: 0
  };
}

describe('QA-PRIV01 · PDF legible de la exportación', () => {
  it('es un PDF válido: cabecera, tabla de referencias con desplazamientos exactos y final', () => {
    const pdf = Buffer.from(renderPersonalDataPdf(sampleExport(), translate, 'es'));
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const startXref = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(startXref, startXref + 4)).toBe('xref');
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    offsets.forEach((offset, index) => expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`));
  });

  it('escribe los acentos y el euro en WinAnsi y escapa los paréntesis y la barra', () => {
    const text = Buffer.from(renderPersonalDataPdf(sampleExport(), translate, 'es')).toString('latin1');
    expect(text).toContain('\\200'); // €
    expect(text).toContain('N\\372ria \\(P\\340rraga\\) \\\\ Ib\\341\\361ez'); // Núria (Pàrraga) \ Ibáñez
    expect(text).toContain('Tus datos en KORUM');
    expect(text).toContain('Huella del dispositivo \\(antifraude\\)');
    expect(text).toContain('Nombre del donante');
    expect(text).toContain('Emails que te hemos enviado');
  });

  it('reparte en varias páginas cuando no cabe', () => {
    const text = Buffer.from(renderPersonalDataPdf(sampleExport(120), translate, 'es')).toString('latin1');
    expect(Number(/\/Count (\d+)/.exec(text)![1])).toBeGreaterThan(3);
  });
});

describe('plazos legales', () => {
  it('una solicitud RGPD vence al mes, también a final de mes', () => {
    expect(oneMonthAfter(new Date('2026-11-05T10:00:00Z')).toISOString()).toBe('2026-12-05T10:00:00.000Z');
    expect(oneMonthAfter(new Date('2027-01-31T08:00:00Z')).toISOString()).toBe('2027-02-28T08:00:00.000Z');
    expect(oneMonthAfter(new Date('2028-01-31T08:00:00Z')).toISOString()).toBe('2028-02-29T08:00:00.000Z');
    expect(oneMonthAfter(new Date('2026-12-15T00:00:00Z')).toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('los datos fiscales vencen 6 años después del cierre del ejercicio', () => {
    expect(lastExpiredFiscalYear(new Date('2027-01-01T00:00:00Z'))).toBe(2020);
    expect(lastExpiredFiscalYear(new Date('2026-12-31T23:59:59Z'))).toBe(2019);
    expect(fiscalCutoff(new Date('2027-06-01T00:00:00Z'), 6).toISOString()).toBe('2021-01-01T00:00:00.000Z');
  });
});
