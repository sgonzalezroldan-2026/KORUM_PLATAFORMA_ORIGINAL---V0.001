import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordConsent } from '@/core/privacy/consents';
import type { KorumPrismaClient } from '@/lib/prisma';
import { inTransaction } from '@/lib/db';
import {
  archiveLegalVersion,
  LegalVersionConflictError,
  lockEntityLegalTexts,
  policyForUser,
  recordAccountTermsAcceptance,
  recordLegalAcceptances,
  resolveLegalVersion
} from '@/services/legal/legal-archive.service';
import { loadLegalPage } from '@/services/legal/legal-page-data';
import { createOrganization, createTestClient, createUser, table } from './test-database';

/**
 * Sprint 5.10a · `QA-LEG01`: archivo inmutable de las versiones publicadas, la vigente de cada idioma (o la del castellano, si falta la traducción o se ha
 * quedado atrás), aceptaciones que solo apuntan a versiones publicadas, consentimientos con una política publicada y su idioma, y el aviso de 30 días a quienes
 * firman por las entidades, ordenado con las altas.
 */

let db: KorumPrismaClient;
const DAY = 24 * 3600 * 1000;
const createdOrgs: string[] = [];

beforeAll(() => {
  db = createTestClient();
});

afterAll(async () => {
  // Los avisos que esta prueba deja a las entidades de otros archivos no se envían: no son de ninguna prueba.
  await db.outboxMessage.deleteMany({ where: { templateKey: 'legal.changeNotice', organizationId: { notIn: createdOrgs } } });
  await db.$disconnect();
});

type ArchiveArgs = Omit<Parameters<typeof archiveLegalVersion>[1], 'now'> & { now?: Date };
const archive = (input: ArchiveArgs) => inTransaction(db, (tx) => archiveLegalVersion(tx, { now: new Date(), ...input }));

async function organizationWithSigners(locales: { director: 'es' | 'ca' | 'en'; cosigner: 'es' | 'ca' | 'en' }) {
  const organization = await createOrganization(db);
  createdOrgs.push(organization.id);
  const director = await createUser(db, { locale: locales.director });
  const cosigner = await createUser(db, { locale: locales.cosigner });
  await db.organizationMember.createMany({ data: [{ organizationId: organization.id, userId: director.id, role: 'DIRECTOR' }, { organizationId: organization.id, userId: cosigner.id, role: 'COSIGNER' }] });
  return { organization, director, cosigner };
}

const noticesTo = (organizationId: string) => db.outboxMessage.findMany({ where: { templateKey: 'legal.changeNotice', organizationId }, orderBy: { id: 'asc' } });

describe('archivo de versiones (QA-LEG01)', () => {
  it('una versión archivada no se reescribe ni se borra; la misma versión con el mismo texto no se duplica, con otro texto o anterior se rechaza', async () => {
    const first = await archive({ document: 'cookies', locale: 'en', version: '2031-01-10', markdown: '# Cookies\n\nFirst.' });
    expect(first).toMatchObject({ created: true, notices: 0 });
    expect(await archive({ document: 'cookies', locale: 'en', version: '2031-01-10', markdown: '# Cookies\n\nFirst.' })).toMatchObject({ created: false });
    await expect(archive({ document: 'cookies', locale: 'en', version: '2031-01-10', markdown: '# Cookies\n\nOther.' })).rejects.toBeInstanceOf(LegalVersionConflictError);
    await expect(archive({ document: 'cookies', locale: 'en', version: '2031-01-09', markdown: '# Cookies\n\nOlder.' })).rejects.toMatchObject({ reason: 'VERSION_OLDER' });
    const row = await db.legalDocumentVersion.findUniqueOrThrow({ where: { document_locale_version: { document: 'cookies', locale: 'en', version: '2031-01-10' } } });
    await expect(db.legalDocumentVersion.update({ where: { id: row.id }, data: { markdown: 'Cambiado' } })).rejects.toThrow(/KORUM_IMMUTABLE/);
    await expect(db.legalDocumentVersion.delete({ where: { id: row.id } })).rejects.toThrow(/KORUM_IMMUTABLE/);
    // Vaciarla de golpe tampoco: ni sola (la frenan ya las aceptaciones que apuntan a ella) ni arrastrando las aceptaciones (la frena su trigger).
    await expect(db.$executeRawUnsafe(`TRUNCATE ${table('LegalDocumentVersion')}`)).rejects.toThrow();
    await expect(db.$executeRawUnsafe(`TRUNCATE ${table('LegalDocumentVersion')} CASCADE`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    await expect(db.$executeRawUnsafe(`UPDATE ${table('LegalDocumentVersion')} SET "markdown" = 'x' WHERE "id" = ${row.id}`)).rejects.toThrow(/KORUM_IMMUTABLE/);
    // La base tampoco admite un documento que no está en el catálogo, una huella mal formada ni un «qué cambia» vacío.
    const base = { locale: 'es' as const, version: '2031-01-01', markdown: 'x', publishedAt: new Date(), effectiveAt: new Date() };
    await expect(db.legalDocumentVersion.create({ data: { ...base, document: 'tabla-de-plazos', contentSha256: 'a'.repeat(64) } })).rejects.toThrow();
    await expect(db.legalDocumentVersion.create({ data: { ...base, document: 'cookies', contentSha256: 'nope' } })).rejects.toThrow();
    await expect(db.legalDocumentVersion.create({ data: { ...base, document: 'cookies', contentSha256: 'a'.repeat(64), changeSummary: '' } })).rejects.toThrow();
  });

  it('la página de cada idioma enseña su versión o, si no hay traducción, la del castellano con su aviso; una versión anterior se puede consultar y otra inventada no existe', async () => {
    const es = await resolveLegalVersion(db, 'aviso-legal', 'es');
    expect(es).toMatchObject({ locale: 'es', fallback: false });
    // El texto archivado ya lleva los datos de la empresa: lo que se ve es lo que tiene la huella.
    expect(es!.markdown).not.toContain('[[');
    const ca = await loadLegalPage(db, 'aviso-legal', 'ca', undefined);
    expect(ca).toMatchObject({ fallback: 'MISSING', archived: false, shown: { locale: 'es', version: es!.version } });

    const cookiesEn = await loadLegalPage(db, 'cookies', 'en', undefined);
    expect(cookiesEn).toMatchObject({ fallback: false, shown: { locale: 'en', version: '2031-01-10' } });
    await archive({ document: 'cookies', locale: 'en', version: '2031-01-11', markdown: '# Cookies\n\nSecond.' });
    const old = await loadLegalPage(db, 'cookies', 'en', '2031-01-10');
    expect(old).toMatchObject({ archived: true, shownStillApplies: false, current: { version: '2031-01-11' }, shown: { markdown: '# Cookies\n\nFirst.' } });
    expect(old!.versions.map((item) => item.version).slice(0, 2)).toEqual(['2031-01-11', '2031-01-10']);
    expect(await loadLegalPage(db, 'cookies', 'en', '2031-02-30')).toBeNull();
    expect(await loadLegalPage(db, 'cookies', 'en', '<script>')).toBeNull();
  });
});

describe('aviso de 30 días a las entidades (decisiones 54, 58 y 85)', () => {
  it('cada versión que sustituye a la que leían quienes firman se les avisa con «qué cambia» y se les aplica a los 30 días; una traducción que se queda atrás deja de valer', async () => {
    const english = await organizationWithSigners({ director: 'en', cosigner: 'en' });
    const mixed = await organizationWithSigners({ director: 'es', cosigner: 'ca' });
    const published = new Date('2026-12-01T09:00:00.000Z');
    const contract = (body: string, providers: string) => `# DPA\n\n${body}\n\n## Anexo III. Proveedores\n\n- ${providers}`;

    // La primera traducción al inglés sustituye, para quien lee en inglés, al castellano que leía hasta ahora: aviso, «qué cambia» obligatorio y 30 días.
    await expect(archive({ document: 'contrato-de-encargo', locale: 'en', version: '2031-02-01', markdown: contract('v1', 'Vercel'), now: published })).rejects.toMatchObject({ reason: 'SUMMARY_REQUIRED' });
    const first = await archive({ document: 'contrato-de-encargo', locale: 'en', version: '2031-02-01', markdown: contract('v1', 'Vercel'), now: published, changeSummary: 'English translation.' });
    // Avisa a quienes leen en inglés (en esta entidad, sus dos personas firmantes; la base compartida puede tener más).
    expect(first.created).toBe(true);
    expect(first.effectiveAt.getTime()).toBe(published.getTime() + 30 * DAY);
    const toEnglish = await noticesTo(english.organization.id);
    expect(toEnglish.map((message) => message.userId).sort()).toEqual([english.director.id, english.cosigner.id].sort());
    expect(toEnglish[0]!.payloadJson).toMatchObject({ document: 'contrato-de-encargo', version: '2031-02-01', effectiveAt: first.effectiveAt.toISOString(), changeSummary: 'English translation.' });
    expect(await noticesTo(mixed.organization.id)).toHaveLength(0);

    // Un cambio urgente solo puede tocar la lista de proveedores; así, se aplica al momento.
    await expect(archive({ document: 'contrato-de-encargo', locale: 'en', version: '2031-02-02', markdown: contract('v2', 'Vercel'), now: published, urgent: true, changeSummary: 'x' })).rejects.toMatchObject({ reason: 'URGENT_NOT_ONLY_PROVIDERS' });
    // Ni un apartado nuevo detrás del Anexo III, que es el último.
    await expect(archive({ document: 'contrato-de-encargo', locale: 'en', version: '2031-02-02', markdown: `${contract('v1', 'Netlify')}\n\n## Anexo III bis\n\n## 18. New clause`, now: published, urgent: true, changeSummary: 'x' })).rejects.toMatchObject({ reason: 'URGENT_NOT_ONLY_PROVIDERS' });
    await expect(archive({ document: 'contrato-de-encargo', locale: 'en', version: '2031-02-02', markdown: `${contract('v1', 'Netlify')}\n\n## 18. New clause\n\nText.`, now: published, urgent: true, changeSummary: 'x' })).rejects.toMatchObject({ reason: 'URGENT_NOT_ONLY_PROVIDERS' });
    const urgent = await archive({ document: 'contrato-de-encargo', locale: 'en', version: '2031-02-02', markdown: contract('v1', 'Netlify'), now: published, urgent: true, changeSummary: 'Netlify replaces Vercel.' });
    expect(urgent.effectiveAt.getTime()).toBe(published.getTime());
    expect((await noticesTo(english.organization.id)).at(-1)!.payloadJson).toMatchObject({ urgent: true, effectiveAt: published.toISOString() });

    // Una versión nueva en castellano llega a todas las cuentas: también a quien lo leía en inglés, porque su traducción se queda atrás y vuelve a valer el castellano.
    const later = new Date(published.getTime() + 60_000);
    await archive({ document: 'contrato-de-encargo', locale: 'es', version: '2031-02-03', markdown: contract('v3', 'Netlify'), now: later, changeSummary: 'Cambia la cláusula 7.' });
    expect((await noticesTo(mixed.organization.id)).map((message) => message.userId).sort()).toEqual([mixed.director.id, mixed.cosigner.id].sort());
    expect(await noticesTo(english.organization.id)).toHaveLength(6);
    expect(await resolveLegalVersion(db, 'contrato-de-encargo', 'en')).toMatchObject({ locale: 'es', version: '2031-02-03', fallback: 'STALE' });
    // Mientras no se aplica, la página dice desde cuándo y enlaza la versión que se sigue aplicando, que es la última ya en vigor (la de la semilla), no otra intermedia.
    const page = await loadLegalPage(db, 'contrato-de-encargo', 'es', undefined, new Date(later.getTime() + DAY));
    expect(page!.stillApplying).toMatchObject({ locale: 'es' });
    expect(page!.stillApplying!.version).not.toBe('2031-02-03');
    expect(page!.shown.changeSummary).toBe('Cambia la cláusula 7.');
    const stillApplying = await loadLegalPage(db, 'contrato-de-encargo', 'es', page!.stillApplying!.version, new Date(later.getTime() + DAY));
    expect(stillApplying).toMatchObject({ archived: true, shownStillApplies: true });
    // Una entidad que se da de alta ahora acepta la versión nueva (decisión 86).
    expect((await resolveLegalVersion(db, 'contrato-de-encargo', 'es'))!.version).toBe('2031-02-03');
    // Otros textos (las condiciones de uso) no se avisan a las entidades.
    expect(await archive({ document: 'terminos', locale: 'en', version: '2031-02-04', markdown: '# Terms\n\nv1' })).toMatchObject({ notices: 0 });
  });

  it('publicar un texto de las entidades espera a que termine un alta que ya lo estaba leyendo (y al revés): el alta nunca acepta una versión ya sustituida sin su aviso', async () => {
    const order: string[] = [];
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (release = resolve));
    const registration = inTransaction(db, async (tx) => {
      await lockEntityLegalTexts(tx, 'shared');
      order.push('alta lee');
      await holding;
      order.push('alta termina');
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const publication = archive({ document: 'condiciones-entidades', locale: 'en', version: '2031-03-01', markdown: '# Terms\n\nEN', changeSummary: 'English translation.' }).then(() => order.push('publicación'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(order).toEqual(['alta lee']);
    release();
    await Promise.all([registration, publication]);
    expect(order).toEqual(['alta lee', 'alta termina', 'publicación']);
  });
});

describe('aceptaciones y consentimientos solo con versiones publicadas (QA-LEG01)', () => {
  it('una aceptación de una versión que no está publicada no se registra; una registrada no se reescribe y solo queda sin cuenta si la cuenta se borra', async () => {
    const user = await createUser(db);
    await expect(inTransaction(db, (tx) => recordLegalAcceptances(tx, { userId: user.id, organizationId: null, source: 'cuenta', items: [{ document: 'terminos', locale: 'es', version: '2099-01-01' }], now: new Date() }))).rejects.toThrow();
    const terms = (await resolveLegalVersion(db, 'terminos', 'es'))!;
    await recordLegalAcceptances(db, { userId: user.id, organizationId: null, source: 'cuenta', items: [{ document: 'terminos', locale: 'es', version: terms.version }], now: new Date() });
    const row = await db.legalAcceptance.findFirstOrThrow({ where: { userId: user.id } });
    await expect(db.legalAcceptance.update({ where: { id: row.id }, data: { version: '2026-01-01' } })).rejects.toThrow(/KORUM_IMMUTABLE/);
    await db.user.delete({ where: { id: user.id } });
    expect(await db.legalAcceptance.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ userId: null, version: terms.version });
  });

  it('la cuenta nueva acepta una sola vez las condiciones de uso vigentes en su idioma o, sin traducción, en castellano', async () => {
    const catalan = await createUser(db, { locale: 'ca' });
    expect(await recordAccountTermsAcceptance(db, catalan.id, new Date())).toBe(true);
    expect(await recordAccountTermsAcceptance(db, catalan.id, new Date())).toBe(false);
    const terms = (await resolveLegalVersion(db, 'terminos', 'es'))!;
    expect(await db.legalAcceptance.findMany({ where: { userId: catalan.id } })).toMatchObject([{ document: 'terminos', locale: 'es', version: terms.version, source: 'cuenta', organizationId: null }]);
    // En inglés ya hay unas condiciones propias, posteriores a las del castellano (publicadas en una prueba anterior): se acepta esa versión.
    const english = await createUser(db, { locale: 'en' });
    await recordAccountTermsAcceptance(db, english.id, new Date());
    expect(await db.legalAcceptance.findFirstOrThrow({ where: { userId: english.id } })).toMatchObject({ locale: 'en', version: '2031-02-04' });
  });

  it('un consentimiento se da con la versión y el idioma de la política publicada de la persona; con una versión o un idioma sin publicar se rechaza, y retirarlo siempre funciona', async () => {
    const person = await createUser(db, { locale: 'ca' });
    const policy = (await policyForUser(db, person.id))!;
    const resolved = (await resolveLegalVersion(db, 'privacidad', 'ca'))!;
    expect(policy).toEqual({ version: resolved.version, locale: resolved.locale });
    // Un idioma en el que esa versión no existe.
    const published = await db.legalDocumentVersion.findMany({ where: { document: 'privacidad', version: policy.version }, select: { locale: true } });
    const otherLocale = (['es', 'ca', 'en'] as const).find((locale) => !published.some((row) => row.locale === locale))!;
    await expect(recordConsent(db, { userId: person.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: '2026-11-01', policyLocale: 'es', source: 'buzon' })).rejects.toThrow(/no está publicada/);
    await expect(recordConsent(db, { userId: person.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: policy.version, policyLocale: otherLocale, source: 'buzon' })).rejects.toThrow(/no está publicada/);
    await expect(recordConsent(db, { userId: person.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: null, source: 'buzon' })).rejects.toThrow();
    await recordConsent(db, { userId: person.id, purpose: 'DEVICE_FINGERPRINT', granted: true, policyVersion: policy.version, policyLocale: policy.locale, source: 'buzon' });
    // Retirarlo sin versión (como si no hubiera política publicada) guarda la versión y el idioma con los que se dio.
    await recordConsent(db, { userId: person.id, purpose: 'DEVICE_FINGERPRINT', granted: false, policyVersion: null, source: 'cuenta' });
    const rows = await db.consentRecord.findMany({ where: { userId: person.id }, orderBy: { id: 'asc' } });
    expect(rows.map(({ granted, policyVersion, policyLocale }) => ({ granted, policyVersion, policyLocale }))).toEqual([
      { granted: true, policyVersion: policy.version, policyLocale: policy.locale },
      { granted: false, policyVersion: policy.version, policyLocale: policy.locale }
    ]);
    // Quien nunca lo dio no deja ninguna fila al retirarlo.
    const never = await createUser(db);
    expect(await recordConsent(db, { userId: never.id, purpose: 'DEVICE_FINGERPRINT', granted: false, policyVersion: null, source: 'cuenta' })).toEqual({ changed: false });
    expect(await db.consentRecord.count({ where: { userId: never.id } })).toBe(0);
  });
});
