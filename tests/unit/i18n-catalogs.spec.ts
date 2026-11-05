import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/types/korum.types';
import { LOCALES, routing } from '@/i18n/routing';
import ca from '../../messages/ca.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';

type Catalog = { [key: string]: CatalogNode | undefined };
type CatalogNode = string | CatalogNode[] | Catalog;
const CATALOGS: Record<string, Catalog> = { es, ca, en };

/** Aplana un catálogo a `ruta.de.la.clave → texto`. */
function flatten(catalog: CatalogNode, prefix = ''): Record<string, string> {
  return Object.entries(catalog).reduce<Record<string, string>>((flat, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === undefined) return flat;
    return typeof value === 'string' ? { ...flat, [path]: value } : { ...flat, ...flatten(value, path) };
  }, {});
}

/** Nombres de variable ICU: `{nombre}` y `{nombre, plural, …}`; el texto de las ramas de un plural no cuenta. */
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1]).sort();

describe('QA-C05 · catálogos de traducción', () => {
  const flat = Object.fromEntries(Object.entries(CATALOGS).map(([locale, catalog]) => [locale, flatten(catalog)]));
  const spanishKeys = Object.keys(flat.es!).sort();

  it('los tres idiomas tienen exactamente las mismas claves', () => {
    expect(Object.keys(flat.ca!).sort()).toEqual(spanishKeys);
    expect(Object.keys(flat.en!).sort()).toEqual(spanishKeys);
  });

  it('ninguna traducción está vacía', () => {
    for (const [locale, entries] of Object.entries(flat)) {
      for (const [key, text] of Object.entries(entries)) {
        expect(text.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('las variables {nombre} coinciden en los tres idiomas', () => {
    for (const key of spanishKeys) {
      const expected = placeholders(flat.es![key]!);
      expect(placeholders(flat.ca![key]!), `ca:${key}`).toEqual(expected);
      expect(placeholders(flat.en![key]!), `en:${key}`).toEqual(expected);
    }
  });

  it('cada idioma traduce los 9 estados de iniciativa', () => {
    for (const locale of ['es', 'ca', 'en']) {
      const statuses = Object.keys(flat[locale]!).filter((key) => key.startsWith('status.initiative.'));
      expect(statuses, locale).toHaveLength(9);
    }
  });

  it('en catalán y en inglés no quedan textos copiados del castellano salvo nombres propios o palabras idénticas', () => {
    // «Avisos» se escribe igual en castellano y en catalán; los nombres de idioma y de marca no se traducen.
    // En la exportación de datos (Sprint 2.5): «Sí», «No», «Idea», «Iniciativa», «NIF», «Completada» y «Fallida» son iguales en catalán.
    const SAME_IN_CATALAN = new Set(['ui.toast.region', 'privacy.export.yes', 'privacy.export.no', 'privacy.export.fields.idea', 'privacy.export.fields.initiative', 'privacy.export.fields.taxId', 'privacy.export.statuses.COMPLETED', 'privacy.export.statuses.FAILED', 'calculator.objective.scoreboard', 'nav.menu']);
    const SAME_IN_ENGLISH = new Set(['privacy.export.no', 'privacy.export.fields.idea']);
    const sameByNature = (locale: string, key: string) =>
      key.startsWith('languageSwitcher.') || key === 'brand.name' || (locale === 'ca' ? SAME_IN_CATALAN : SAME_IN_ENGLISH).has(key);
    const sameAsSpanish = (locale: string) => spanishKeys.filter((key) => flat[locale]![key] === flat.es![key] && !sameByNature(locale, key));
    expect(sameAsSpanish('ca')).toEqual([]);
    expect(sameAsSpanish('en')).toEqual([]);
  });

  /** La única mención admitida de «Banco de España» es la redacción aprobada de Paycomet (Regla 03 §4); referida a KORUM sigue prohibida. */
  const APPROVED_PAYCOMET_PHRASE = /autorizada por el Banco de España/g;

  it('no hay vocabulario prohibido en los textos públicos (propina, banco, escrow)', () => {
    for (const [locale, entries] of Object.entries(flat)) {
      for (const [key, text] of Object.entries(entries)) {
        expect(text.replace(APPROVED_PAYCOMET_PHRASE, ''), `${locale}:${key}`).not.toMatch(/\bpropinas?\b|\bbanco\b|\bescrow\b|\btip\b/i);
      }
    }
  });
});

describe('idiomas del enrutado', () => {
  it('el enrutado y los contratos de tipos usan los mismos idiomas y el mismo idioma por defecto', () => {
    expect([...LOCALES]).toEqual([...SUPPORTED_LOCALES]);
    expect(routing.defaultLocale).toBe(DEFAULT_LOCALE);
    expect(routing.localePrefix).toBe('as-needed');
  });
});
