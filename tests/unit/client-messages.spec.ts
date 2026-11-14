import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AbstractIntlMessages } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { clientMessagesFor, clientSectionsFor, PUBLIC_CLIENT_SECTIONS, SERVER_ONLY_SECTIONS, type ClientZone } from '@/i18n/client-messages';
import ca from '../../messages/ca.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';

/**
 * Sprint 5.5a (QA-X01 y auditoría de seguridad): el navegador solo recibe las secciones del catálogo que usan las piezas de cada zona. Esta prueba
 * parte de las páginas y layouts de cada zona, **sigue sus importaciones** (`@/…` y relativas) y revisa todo archivo alcanzado que use el gancho
 * `useTranslations`: con o sin `'use client'`, porque un componente de servidor también corre en el navegador si lo monta uno de cliente (el logotipo
 * dentro de un diálogo, el formulario de segundo factor dentro del soporte de `/ayuda`). Cuenta de más (un componente de servidor que nunca baja al
 * navegador también entra), nunca de menos.
 */

const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');
const APP = join(SRC, 'app', '[locale]');

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Resuelve una importación del código del proyecto a su archivo; las de paquetes (`next`, `react`…) y los JSON no cuentan. */
function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

/** Todos los archivos del proyecto que alcanzan las entradas siguiendo sus importaciones. */
function reachable(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const target = resolveImport(file, match[1]!);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

const sectionsUsed = (source: string) => [...source.matchAll(/useTranslations\(\s*['"`]([\w.]+)/g)].map((match) => match[1]!.split('.')[0]!);

/** Entradas de cada zona: lo que cuelga del proveedor raíz (pública) y lo que cuelga de cada `PrivateIntlProvider`. */
const ZONE_ENTRIES: Record<'public' | Exclude<ClientZone, 'dev'>, string[]> = {
  public: [
    ...filesIn(join(APP, '(public)')),
    ...filesIn(join(APP, '(marketing)')),
    ...filesIn(join(APP, '[...rest]')),
    ...['layout.tsx', 'error.tsx', 'not-found.tsx', 'forbidden.tsx'].map((file) => join(APP, file))
  ],
  auth: filesIn(join(APP, '(auth)')),
  account: filesIn(join(APP, '(account)')),
  dashboard: filesIn(join(APP, '(dashboard)')),
  admin: filesIn(join(APP, '(superadmin)'))
};

describe('secciones de textos que llegan al navegador en cada zona', () => {
  for (const [zone, entries] of Object.entries(ZONE_ENTRIES) as Array<[keyof typeof ZONE_ENTRIES, string[]]>) {
    it(`${zone}: todo lo que alcanzan sus páginas y usa useTranslations tiene su sección en la zona`, () => {
      const allowed = clientSectionsFor(zone);
      expect(allowed).not.toBe('ALL_BUT_SERVER_ONLY');
      const problems: string[] = [];
      for (const file of reachable(entries)) {
        const source = readFileSync(file, 'utf8');
        if (!source.includes('useTranslations(')) continue;
        if (/useTranslations\(\s*\)/.test(source)) problems.push(`${file}: useTranslations() sin sección necesitaría el catálogo entero`);
        for (const section of sectionsUsed(source)) if (!(allowed as ReadonlySet<string>).has(section)) problems.push(`${file.slice(ROOT.length + 1)} → ${section}`);
      }
      expect(problems).toEqual([]);
    });
  }

  it('lo público nunca recibe textos internos: ni del panel, ni de la consola, ni de la portería, ni del alta, ni de Mi Hucha, ni de los emails', () => {
    const sections = clientSectionsFor('public') as ReadonlySet<string>;
    for (const section of ['panel', 'admin', 'gate', 'registration', 'hucha', 'ideas', 'email']) expect(sections.has(section), section).toBe(false);
  });

  it('cada zona privada recibe solo lo suyo: la consola no llega al acceso, la cuenta ni el panel, y el panel no llega a la consola', () => {
    const has = (zone: Exclude<ClientZone, 'dev'>, section: string) => (clientSectionsFor(zone) as ReadonlySet<string>).has(section);
    for (const zone of ['auth', 'account', 'dashboard'] as const) expect(has(zone, 'admin'), zone).toBe(false);
    for (const zone of ['auth', 'account', 'admin'] as const) {
      expect(has(zone, 'panel'), zone).toBe(false);
      expect(has(zone, 'gate'), zone).toBe(false);
    }
    for (const zone of ['auth', 'account', 'dashboard', 'admin'] as const) expect(has(zone, 'email'), zone).toBe(false);
  });

  it('las secciones públicas existen en los tres idiomas y pesan una fracción del catálogo', () => {
    for (const [locale, catalog] of Object.entries({ es, ca, en })) {
      const messages = catalog as unknown as AbstractIntlMessages;
      const selected = clientMessagesFor('public', messages);
      expect(Object.keys(selected).sort(), locale).toEqual([...PUBLIC_CLIENT_SECTIONS].sort());
      // Antes viajaba el catálogo entero (~400 KB) en cada página y en cada precarga de enlace.
      expect(JSON.stringify(selected).length, locale).toBeLessThan(JSON.stringify(messages).length * 0.25);
    }
  });

  it('la galería de desarrollo recibe todo menos las plantillas de email', () => {
    const selected = clientMessagesFor('dev', es as unknown as AbstractIntlMessages);
    expect(selected).not.toHaveProperty('email');
    expect(Object.keys(selected).length).toBe(Object.keys(es).length - SERVER_ONLY_SECTIONS.length);
  });
});
