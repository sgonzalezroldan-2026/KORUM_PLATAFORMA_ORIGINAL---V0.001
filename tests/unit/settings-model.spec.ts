import { describe, expect, it } from 'vitest';
import {
  compareLegalVersions,
  CRAWLER_USER_AGENT,
  fieldI18nKey,
  isLegalDocument,
  isLegalLocale,
  isSectionId,
  LEGAL_VERSION_PATTERN,
  legalKeyOf,
  legalToday,
  nextLegalVersion,
  parseLegalVersion,
  SEARCH_VERIFICATION_TOKEN,
  SECTION_FIELDS,
  SECTION_SECRETS,
  SETTINGS_SECTIONS
} from '@/core/admin/settings-model';
import { SECRET_DEFINITIONS, SETTING_DEFINITIONS, settingDefinition } from '@/services/settings/setting-definitions';
import ca from '../../messages/ca.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';

/** Sprint 5.4 · modelo puro de `/admin/ajustes`: versiones de los textos legales, qué lleva cada bloque y que cada campo tenga su texto en los tres idiomas (QA-A05). */

describe('versiones de los textos legales', () => {
  it('reconoce AAAA-MM-DD con secuencia opcional y rechaza fechas imposibles o con otro formato', () => {
    expect(parseLegalVersion('2026-11-13')).toEqual({ date: '2026-11-13', sequence: 0 });
    expect(parseLegalVersion('2026-11-13.2')).toEqual({ date: '2026-11-13', sequence: 2 });
    for (const bad of ['2026-13-01', '2026-02-30', '2026-11-13.', '2026-11-13.1234', '13-11-2026', 'ayer', '', '2026-11-13 ', '2026-11-13\n']) expect(parseLegalVersion(bad)).toBeNull();
    // Solo la forma canónica: «.0» y los ceros a la izquierda serían la misma versión escrita de otra forma.
    for (const bad of ['2026-11-13.0', '2026-11-13.00', '2026-11-13.01', '2026-11-13.010']) expect(parseLegalVersion(bad), bad).toBeNull();
    for (const regex of [LEGAL_VERSION_PATTERN]) for (const bad of ['2026-11-13.0', '2026-11-13.01']) expect(regex.test(bad)).toBe(false);
    expect(LEGAL_VERSION_PATTERN.test('2026-11-13.12')).toBe(true);
    // Un año bisiesto sí vale y uno que no lo es, no.
    expect(parseLegalVersion('2028-02-29')).not.toBeNull();
    expect(parseLegalVersion('2027-02-29')).toBeNull();
  });

  it('ordena por fecha y, el mismo día, por secuencia (.10 va después de .9, no antes)', () => {
    expect(compareLegalVersions('2026-11-13', '2026-11-14')).toBeLessThan(0);
    expect(compareLegalVersions('2026-12-01', '2026-11-30')).toBeGreaterThan(0);
    expect(compareLegalVersions('2026-11-13', '2026-11-13')).toBe(0);
    expect(compareLegalVersions('2026-11-13.1', '2026-11-13')).toBeGreaterThan(0);
    expect(compareLegalVersions('2026-11-13.10', '2026-11-13.9')).toBeGreaterThan(0);
    // Una versión sin formato válido va antes que cualquier válida.
    expect(compareLegalVersions('basura', '2026-11-13')).toBeLessThan(0);
    expect(compareLegalVersions('2026-11-13', 'basura')).toBeGreaterThan(0);
    expect(compareLegalVersions('a', 'b')).toBe(0);
  });

  it('la fecha de hoy es la de España, no la de UTC (a las 23:30 UTC de noviembre ya es el día siguiente en Madrid)', () => {
    expect(legalToday(new Date('2026-11-13T23:30:00Z'))).toBe('2026-11-14');
    expect(legalToday(new Date('2026-11-13T12:00:00Z'))).toBe('2026-11-13');
    // Con la hora de verano (UTC+2), a las 22:30 UTC ya es el día siguiente.
    expect(legalToday(new Date('2026-07-01T22:30:00Z'))).toBe('2026-07-02');
  });

  it('propone la versión de hoy para un texto nuevo y la siguiente del mismo día para uno ya publicado hoy', () => {
    const now = new Date('2026-11-13T10:00:00Z');
    expect(nextLegalVersion(null, now)).toBe('2026-11-13');
    expect(nextLegalVersion('2026-11-01', now)).toBe('2026-11-13');
    expect(nextLegalVersion('2026-11-13', now)).toBe('2026-11-13.1');
    expect(nextLegalVersion('2026-11-13.3', now)).toBe('2026-11-13.4');
    expect(nextLegalVersion('versión rara', now)).toBe('2026-11-13');
  });

  it('solo admite los documentos, idiomas y bloques de la lista', () => {
    expect(isLegalDocument('terminos')).toBe(true);
    expect(isLegalDocument('aviso-legal')).toBe(true);
    expect(isLegalDocument('inventado')).toBe(false);
    expect(isLegalDocument(undefined)).toBe(false);
    expect(isLegalLocale('ca')).toBe(true);
    expect(isLegalLocale('fr')).toBe(false);
    expect(legalKeyOf('cookies', 'en')).toBe('legal.cookies.en');
    expect(isSectionId('pagos')).toBe(true);
    expect(isSectionId('__proto__')).toBe(false);
    expect(isSectionId(3)).toBe(false);
  });
});

describe('nombres de rastreadores y códigos de verificación', () => {
  it('un rastreador es un nombre de producto: sin saltos de línea, espacios, asteriscos ni barras (se escribe tal cual en robots.txt)', () => {
    for (const ok of ['GPTBot', 'Claude-SearchBot', 'Meta-ExternalAgent', 'Applebot-Extended', 'bot.v2', 'A_b']) expect(CRAWLER_USER_AGENT.test(ok)).toBe(true);
    for (const bad of ['GPTBot\nAllow: /', 'GPTBot\r', '*', 'Mi Bot', 'a', '-bot', 'bot/1.0', 'bot;x', '', 'x'.repeat(101), 'bot x']) expect(CRAWLER_USER_AGENT.test(bad)).toBe(false);
  });

  it('un código de verificación solo lleva letras, cifras, guion y guion bajo', () => {
    expect(SEARCH_VERIFICATION_TOKEN.test('abcDEF123_-xyz')).toBe(true);
    for (const bad of ['"><script>', 'corto', 'con espacios 1234', 'a'.repeat(201), '12345678\n']) expect(SEARCH_VERIFICATION_TOKEN.test(bad)).toBe(false);
  });
});

describe('qué lleva cada bloque', () => {
  const allKeys = SETTINGS_SECTIONS.flatMap((section) => SECTION_FIELDS[section].map((field) => field.key));

  it('cada campo existe en el catálogo de ajustes (una clave que no esté allí no se podría guardar) y ninguno está en dos bloques', () => {
    for (const key of allKeys) expect(() => settingDefinition(key)).not.toThrow();
    expect(new Set(allKeys).size).toBe(allKeys.length);
    for (const key of allKeys) expect(Object.hasOwn(SETTING_DEFINITIONS, key)).toBe(true);
  });

  it('ningún secreto se mezcla con los campos sencillos, y cada secreto de un bloque existe en el catálogo de secretos', () => {
    for (const keys of Object.values(SECTION_SECRETS)) for (const key of keys ?? []) expect(Object.hasOwn(SECRET_DEFINITIONS, key)).toBe(true);
    for (const key of Object.keys(SECRET_DEFINITIONS)) expect(allKeys).not.toContain(key);
  });

  it('SMTP no se ofrece (no tiene adaptador) y los selectores llevan solo valores que el catálogo acepta', () => {
    expect(SECTION_FIELDS.email.find((field) => field.key === 'email.provider')?.options).toEqual(['brevo']);
    for (const section of SETTINGS_SECTIONS) {
      for (const field of SECTION_FIELDS[section]) {
        if (field.kind !== 'select') continue;
        for (const option of field.options ?? []) expect(settingDefinition(field.key).schema.safeParse(option).success).toBe(true);
      }
    }
  });
});

type Catalog = { admin: { settings: Record<string, unknown>; nav: Record<string, string> } };
const CATALOGS: Array<[string, Catalog]> = [
  ['es', es as unknown as Catalog],
  ['ca', ca as unknown as Catalog],
  ['en', en as unknown as Catalog]
];

/** Todas las claves hoja de un objeto, con su ruta (`fields.paycomet_jetId.label`). */
function leaves(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
}

/** Los marcadores `{nombre}` de un texto (sin contar las ramas internas de un plural). */
const placeholders = (text: string) => [...new Set([...text.matchAll(/\{([a-zA-Z]+)(?:,|\})/g)].map((match) => match[1]))].sort();

describe('textos de la pantalla en los tres idiomas', () => {
  it('el castellano, el catalán y el inglés tienen exactamente las mismas claves y los mismos marcadores', () => {
    const [esLeaves, caLeaves, enLeaves] = CATALOGS.map(([, catalog]) => new Map(leaves(catalog.admin.settings)));
    for (const [name, other] of [['ca', caLeaves], ['en', enLeaves]] as const) {
      expect([...other!.keys()].sort(), `claves de ${name}`).toEqual([...esLeaves!.keys()].sort());
      for (const [key, text] of esLeaves!) expect(placeholders(other!.get(key) ?? ''), `marcadores de ${name} en ${key}`).toEqual(placeholders(text));
    }
    for (const [, catalog] of CATALOGS) expect(catalog.admin.nav.settings).toBeTruthy();
  });

  it('cada campo, secreto, motivo y estado que usa la pantalla tiene su texto (etiqueta, ayuda y opciones)', () => {
    for (const [name, catalog] of CATALOGS) {
      const settings = catalog.admin.settings as Record<string, Record<string, Record<string, unknown>>>;
      for (const section of SETTINGS_SECTIONS) {
        for (const field of SECTION_FIELDS[section]) {
          const entry = settings.fields?.[fieldI18nKey(field.key)];
          expect(entry?.label, `${name}: etiqueta de ${field.key}`).toBeTruthy();
          if (field.kind === 'json') continue;
          expect(entry?.help, `${name}: ayuda de ${field.key}`).toBeTruthy();
          for (const option of field.options ?? []) expect((entry?.options as Record<string, string> | undefined)?.[option], `${name}: opción ${option} de ${field.key}`).toBeTruthy();
        }
      }
      for (const key of Object.keys(SECRET_DEFINITIONS)) {
        if (key === 'email.smtp.password') continue;
        expect(settings.secrets?.[fieldI18nKey(key)]?.label, `${name}: secreto ${key}`).toBeTruthy();
      }
      for (const reason of ['INVALID', 'STALE', 'UNKNOWN', 'SERVER_IP_REQUIRED', 'SENDER_REQUIRED', 'INVOICING_PAIR', 'WALLET_PROVIDER_REQUIRED', 'WALLET_KEY_REQUIRED', 'WALLET_CONFIRMATION_REQUIRED', 'WALLET_BALANCES_OPEN', 'VERSION_OLDER', 'VERSION_IN_USE', 'VERSION_NOT_TODAY', 'PUBLISHED_TO_DRAFT', 'SECRET_REQUIRED', 'FIELD_REQUIRED', 'WALLET_PROVIDER_LOCKED', 'INVALID_EMAIL', 'ALREADY_SUPERADMIN', 'ENTITY_MEMBER', 'RATE_LIMITED', 'SELF', 'LAST_ADMIN', 'NOT_FOUND']) {
        expect((settings.reason as unknown as Record<string, string>)[reason], `${name}: motivo ${reason}`).toBeTruthy();
      }
    }
  });

  it('los textos de la consola no llaman a KORUM banco ni dicen «propina» (Regla 03 §4)', () => {
    for (const [name, catalog] of CATALOGS) {
      for (const [key, text] of leaves(catalog.admin.settings)) {
        expect(text, `${name}: ${key}`).not.toMatch(/\bpropina\b|cuenta bancaria|bank account|compte bancari/i);
      }
    }
  });
});
