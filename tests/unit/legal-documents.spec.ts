import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONDITIONS_BY_SLUG,
  effectiveDateFor,
  fillMarkers,
  LEGAL_DOCUMENT_INFO,
  LEGAL_DOCUMENTS,
  LEGAL_KEY_PATTERN,
  legalPathOf,
  publishableMarkdown,
  resolveLegalLink,
  unknownMarkers,
  type LegalDocument
} from '@/core/legal/legal-catalog';
import { headingAnchor, parseLegalMarkdown, plainText, type LegalBlock, type LegalInline } from '@/core/legal/legal-markdown';
import { loadLegalSeedTexts } from '@/seed/legal-texts';

/** Sprint 5.10a · `QA-LEG01`: catálogo de los textos legales, su lector de Markdown y los textos validados de docs/legal tal como se publican. */

const allInline = (blocks: readonly LegalBlock[]): LegalInline[] =>
  blocks.flatMap((block) => {
    switch (block.type) {
      case 'heading':
      case 'paragraph':
        return block.inline;
      case 'list':
        return block.items.flatMap((item) => [...item.inline, ...allInline(item.children)]);
      case 'table':
        return [...block.header.flat(), ...block.rows.flat(2)];
      case 'quote':
        return allInline(block.blocks);
      case 'rule':
        return [];
    }
  });
const links = (inline: readonly LegalInline[]): string[] => inline.flatMap((node) => (node.type === 'link' ? [node.href, ...links(node.children)] : node.type === 'strong' || node.type === 'em' ? links(node.children) : []));

describe('catálogo de los textos legales', () => {
  it('nueve documentos, cada uno con una ruta pública propia y su archivo de docs/legal; las condiciones de cada servicio cuelgan de /condiciones', () => {
    expect(LEGAL_DOCUMENTS).toHaveLength(9);
    const paths = LEGAL_DOCUMENTS.map(legalPathOf);
    expect(new Set(paths).size).toBe(9);
    for (const [slug, document] of Object.entries(CONDITIONS_BY_SLUG)) expect(legalPathOf(document)).toBe(`/condiciones/${slug}`);
    expect(legalPathOf('terminos')).toBe('/condiciones');
    expect(LEGAL_KEY_PATTERN.exec('legal.contrato-de-encargo.ca')?.slice(1)).toEqual(['contrato-de-encargo', 'ca']);
    expect(LEGAL_KEY_PATTERN.test('legal.tabla-de-plazos.es')).toBe(false);
    expect(LEGAL_KEY_PATTERN.test('legal.terminos.fr')).toBe(false);
  });

  it('los textos de las entidades se aplican a los 30 días cuando sustituyen a otra versión; los demás, al publicarse', () => {
    const now = new Date('2026-12-01T10:00:00Z');
    expect(effectiveDateFor('condiciones-entidades', now, true).toISOString()).toBe('2026-12-31T10:00:00.000Z');
    expect(effectiveDateFor('contrato-de-encargo', now, true).toISOString()).toBe('2026-12-31T10:00:00.000Z');
    expect(effectiveDateFor('contrato-de-encargo', now, false)).toEqual(now);
    expect(effectiveDateFor('privacidad', now, true)).toEqual(now);
  });

  it('las marcas se rellenan con los datos de la empresa; un dato que falta sale como pendiente y una marca inventada se detecta', () => {
    const text = 'Titular: [[RAZÓN SOCIAL]] ([[NIF]]). Registro: [[DATOS REGISTRALES]]. Web: [[DOMINIO]]. Otra: [[EMAIL DE VENTAS]].';
    expect(fillMarkers(text, { legalName: 'KORUM Plataforma, S.L.', taxId: 'B12345678', domain: 'korum.app' }, '(dato pendiente)')).toBe(
      'Titular: KORUM Plataforma, S.L. (B12345678). Registro: (dato pendiente). Web: korum.app. Otra: [[EMAIL DE VENTAS]].'
    );
    expect(unknownMarkers(text)).toEqual(['EMAIL DE VENTAS']);
  });

  it('los enlaces entre documentos van a su página pública; los documentos internos, un protocolo peligroso o un destino raro se quedan en texto', () => {
    expect(resolveLegalLink('politica-de-privacidad.md')).toEqual({ kind: 'document', document: 'privacidad', hash: '' });
    expect(resolveLegalLink('condiciones-generales.md#4-campanas')).toEqual({ kind: 'document', document: 'terminos', hash: '#4-campanas' });
    expect(resolveLegalLink('/precios')).toEqual({ kind: 'page', path: '/precios' });
    expect(resolveLegalLink('mailto:privacidad@korum.app')).toEqual({ kind: 'external', href: 'mailto:privacidad@korum.app' });
    for (const href of ['tabla-de-plazos.md', 'evaluacion-de-impacto.md', '../CUMPLIMIENTO_LEGAL_Y_PRIVACIDAD.md', 'javascript:alert(1)', '//evil.example', 'http://inseguro.example', 'data:text/html,hola']) {
      expect(resolveLegalLink(href), href).toEqual({ kind: 'text' });
    }
  });

  it('del archivo de docs/legal se publica el título y lo que va tras la primera raya: las notas internas del recuadro no', () => {
    const file = '# Aviso legal\n\n> **Documento:** `aviso-legal` · **Versión:** 2026-11-18\n> Nota interna.\n\n---\n\n## 1. Quién\n\nTexto.\n\n---\n\n## Anexo';
    expect(publishableMarkdown(file)).toBe('# Aviso legal\n\n## 1. Quién\n\nTexto.\n\n---\n\n## Anexo');
  });
});

describe('lector del Markdown de los textos', () => {
  it('títulos con ancla, párrafos, negrita, cursiva, código y enlaces; el código se lee antes que el formato', () => {
    const blocks = parseLegalMarkdown('# Política\n\n## 4.1 Cómo avisarnos\n\nUsa **siempre** *Mi cuenta*, el prefijo `__Secure-` y [la política](politica-de-privacidad.md).');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ type: 'heading', level: 2, id: '41-como-avisarnos' });
    const paragraph = blocks[2] as Extract<LegalBlock, { type: 'paragraph' }>;
    expect(paragraph.inline.map((node) => node.type)).toEqual(['text', 'strong', 'text', 'em', 'text', 'code', 'text', 'link', 'text']);
    expect(plainText(paragraph.inline)).toBe('Usa siempre Mi cuenta, el prefijo __Secure- y la política.');
    expect(headingAnchor('Anexo III. Proveedores')).toBe('anexo-iii-proveedores');
  });

  it('listas con número y anidadas, tablas, citas y rayas', () => {
    const blocks = parseLegalMarkdown('3. Tercero\n4. Cuarto\n  - Dentro\n  - También\n\n| A | B |\n| :--- | :--- |\n| 1 | **2** |\n\n> Cita\n>\n> - con lista\n\n---');
    expect(blocks.map((block) => block.type)).toEqual(['list', 'table', 'quote', 'rule']);
    const list = blocks[0] as Extract<LegalBlock, { type: 'list' }>;
    expect(list).toMatchObject({ ordered: true, start: 3 });
    expect(list.items).toHaveLength(2);
    expect(list.items[1]!.children[0]).toMatchObject({ type: 'list', ordered: false });
    const table = blocks[1] as Extract<LegalBlock, { type: 'table' }>;
    expect(table.header.map(plainText)).toEqual(['A', 'B']);
    expect(table.rows[0]![1]![0]).toMatchObject({ type: 'strong' });
    expect((blocks[2] as Extract<LegalBlock, { type: 'quote' }>).blocks.map((block) => block.type)).toEqual(['paragraph', 'list']);
  });

  it('el HTML se queda en texto: nada se interpreta', () => {
    const blocks = parseLegalMarkdown('<script>alert(1)</script> y <img src=x onerror=alert(1)>');
    expect(blocks).toEqual([{ type: 'paragraph', inline: [{ type: 'text', value: '<script>alert(1)</script> y <img src=x onerror=alert(1)>' }] }]);
  });
});

describe('los textos validados de docs/legal tal como se publican', () => {
  const texts = loadLegalSeedTexts();

  it('los nueve declaran su versión, empiezan por su título, no tienen marcas inventadas ni notas internas y todo enlace lleva a un documento o a una página', () => {
    expect(texts.map((text) => text.document).sort()).toEqual([...LEGAL_DOCUMENTS].sort());
    for (const text of texts) {
      expect(text.version, text.document).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(text.markdown.startsWith('# '), text.document).toBe(true);
      expect(text.markdown, text.document).not.toMatch(/Las notas de este recuadro no forman parte del texto publicado/);
      expect(unknownMarkers(text.markdown), text.document).toEqual([]);
      for (const href of links(allInline(parseLegalMarkdown(text.markdown)))) {
        const target = resolveLegalLink(href);
        // Solo la tabla de plazos, que es interna, se queda en texto (la política de privacidad la cita sin enlazarla).
        if (target.kind === 'text') expect(href, `${text.document}: ${href}`).toBe('tabla-de-plazos.md');
      }
    }
  });

  it('antes de publicar, el contrato de encargo (Anexo III), el registro de actividades y la política de privacidad (§6) nombran los mismos proveedores', () => {
    const read = (file: string) => fs.readFileSync(path.join(process.cwd(), 'docs', 'legal', file), 'utf8');
    const firstColumn = (section: string) =>
      section
        .split('\n')
        .filter((line) => /^\|\s*[A-Z]/.test(line) && !/^\|\s*(Proveedor|Qué)\b/.test(line))
        .map((line) => line.split('|')[1]!.trim());
    const contract = read(LEGAL_DOCUMENT_INFO['contrato-de-encargo'].sourceFile);
    const annex = firstColumn(contract.slice(contract.indexOf('## Anexo III')));
    const privacy = read(LEGAL_DOCUMENT_INFO.privacidad.sourceFile);
    const section6 = privacy.slice(privacy.indexOf('## 6.'), privacy.indexOf('## 7.'));
    const privacyProviders = firstColumn(section6).filter((name) => name !== 'Proveedor de facturación');
    const registry = read('registro-de-actividades.md').split('\n').find((line) => line.includes('**Proveedores (encargados de KORUM)**'))!;
    const named = ['Vercel', 'Supabase', 'Brevo', 'Sentry', 'Plausible'];
    expect(annex).toEqual(['Vercel', 'Supabase', 'Brevo', 'Sentry']);
    expect(privacyProviders).toEqual(named);
    for (const name of named) expect(registry, name).toContain(name);
    // El Anexo III solo deja fuera a los dos proveedores que no tratan datos de los que la entidad es responsable, y lo dice.
    expect(contract).toMatch(/otros dos proveedores para sus propios tratamientos/);
    expect(section6).toContain('Proveedor de facturación');
    expect(registry).toContain('proveedor de facturación');
  });

  it('la tabla de plazos, la evaluación de impacto y el registro de actividades son internos: ningún texto publicado los enlaza', () => {
    for (const text of texts) expect(text.markdown, text.document).not.toMatch(/\]\((?:evaluacion-de-impacto|registro-de-actividades)\.md/);
    const documents: LegalDocument[] = texts.map((text) => text.document);
    expect(documents).not.toContain('tabla-de-plazos');
  });
});

describe('el lector no se atasca con un texto mal formado (auditoría de seguridad del 5.10a)', () => {
  it('aperturas sin cerrar se leen en tiempo lineal y se quedan como texto', () => {
    // Se mide cuánto crece el tiempo al cuadruplicar el texto, no un tiempo absoluto (que depende de lo cargada que esté la máquina): lineal, unas 4 veces;
    // la versión cuadrática anterior, unas 16. El margen de 25 ms absorbe el ruido de las medidas muy cortas.
    const timeOf = (source: string) => {
      const started = performance.now();
      const blocks = parseLegalMarkdown(source);
      const elapsed = performance.now() - started;
      expect(plainText(allInline(blocks)).length).toBeGreaterThan(0);
      return elapsed;
    };
    for (const piece of ['**a ', '[a', '*a ', '`a', '[a](']) {
      const small = Math.min(timeOf(piece.repeat(2_500)), timeOf(piece.repeat(2_500)));
      const large = Math.min(timeOf(piece.repeat(10_000)), timeOf(piece.repeat(10_000)));
      expect(large, piece).toBeLessThan(small * 8 + 25);
    }
  });
});

describe('citas y listas anidadas sin fin (auditoría de seguridad del 5.10a)', () => {
  it('5.000 «>» seguidos o una lista de 5.000 niveles no agotan la pila: más allá de 8 niveles se leen como texto', () => {
    const quotes = parseLegalMarkdown(`${'>'.repeat(5000)} hola`);
    let depth = 0;
    let block: LegalBlock | undefined = quotes[0];
    while (block?.type === 'quote') {
      depth += 1;
      block = block.blocks[0];
    }
    expect(depth).toBe(8);
    expect(block?.type).toBe('paragraph');
    const list = Array.from({ length: 5000 }, (_, level) => `${'  '.repeat(level)}- nivel ${level}`).join('\n');
    expect(() => parseLegalMarkdown(list)).not.toThrow();
  });
});
