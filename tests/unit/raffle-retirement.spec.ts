import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@/core/audit/audit-catalog';
import { DOSSIER_EMAIL_TEMPLATE_KEYS } from '@/core/dossier/dossier-texts';
import { SECTION_FIELDS } from '@/core/admin/settings-model';
import { CAMPAIGN_TEMPLATES } from '@/core/studio/campaign-templates';
import { studioDraftSchema, TICKETING_CATEGORY } from '@/core/studio/studio-draft';

/**
 * QA-RET01 · Retirada de las rifas (Sprints 5.12a y 5.12b). El código de la aplicación, el esquema, la semilla, los scripts, los catálogos de textos y las
 * pruebas ya no hablan de rifas, papeletas ni sorteos, y la documentación vigente solo las nombra para decir que se retiraron. Quedan fuera, por ser
 * historia: las migraciones antiguas (no se reescriben) y la que las retira, la bitácora, la prerrevisión legal y fiscal, las fichas cerradas del plan y
 * las casillas resueltas de los demás documentos, el prototipo congelado (referencia funcional, con su nota de «función retirada» en el índice) y las dos
 * pruebas que vigilan la retirada (esta y la de integración), igual que el escáner de invariantes, que nombra las guardas retiradas para impedir que vuelvan.
 */

const ROOT = process.cwd();
const RAFFLE_WORDS = /raffle|(?<![a-záéíóúñ])rifas?(?![a-záéíóúñ])|papeleta|papereta|sorteo|sorteig|sortej|butllet|tómbol|tombol/i;
/** En los catálogos también el inglés del sorteo («draw», «lottery»); «withdrawn» no cuenta. */
const CATALOG_WORDS = new RegExp(`${RAFFLE_WORDS.source}|(?<![a-z])draw(s|n|ing)?(?![a-z])|lottery|prize draw`, 'i');
/** Una mención en la documentación vigente tiene que hablar de la retirada. */
const RETIREMENT = /retir|retired|5\.12/i;

function filesUnder(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return name === 'generated' || name === 'node_modules' ? [] : filesUnder(full, extensions);
    return extensions.some((extension) => name.endsWith(extension)) ? [full] : [];
  });
}

// «Veri*factu» contiene «rifa» en mayúsculas y no tiene nada que ver.
const mentions = (line: string, words: RegExp = RAFFLE_WORDS) => words.test(line.replace(/verifactu/gi, ''));

const hits = (files: string[]) =>
  files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => mentions(line))
      .map(({ index }) => `${path.relative(ROOT, file)}:${index + 1}`)
  );

type CatalogNode = string | { [key: string]: CatalogNode } | CatalogNode[];
const flatten = (node: CatalogNode, prefix = ''): Array<[string, string]> =>
  typeof node === 'string' ? [[prefix, node]] : Object.entries(node).flatMap(([key, value]) => flatten(value, prefix ? `${prefix}.${key}` : key));

/** Documentación vigente: todo Markdown del repositorio salvo lo que es historia o se genera (`.claude/` es copia de `.agents/`). */
const HISTORICAL_DOCS = new Set(['docs/BITACORA_SPRINTS.md', 'docs/PRERREVISION_LEGAL_Y_FISCAL.md']);
function currentDocs(): string[] {
  const roots = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'README.md'].map((name) => path.join(ROOT, name));
  return [...roots, ...filesUnder(path.join(ROOT, 'docs'), ['.md']), ...filesUnder(path.join(ROOT, '.agents'), ['.md'])].filter(
    (file) => !HISTORICAL_DOCS.has(path.relative(ROOT, file).split(path.sep).join('/'))
  );
}

/**
 * Lo que ya está cerrado es historia y se conserva tal como se escribió: una ficha del plan marcada `[x]` (con todas sus líneas, hasta la ficha o el
 * título siguientes) y una casilla resuelta `- [x]` de cualquier otro documento (los puntos legales de CUMPLIMIENTO §9, por ejemplo). Lo abierto (fichas
 * por hacer, casillas pendientes, avisos, tablas y texto corrido) tiene que estar al día. Se vacían las líneas, no se quitan, para que los números sigan.
 */
const CHECKBOX = /^\s*- \[[ x]\] /;
const HEADING = /^#{1,6} /;
function withoutClosedItems(file: string, text: string): string[] {
  const lines = text.split('\n');
  const isPlan = file.endsWith('PLAN_IMPLEMENTACION_ATOMICO.md');
  let insideClosedSprint = false;
  return lines.map((line) => {
    const opensItem = /^- \[[ x]\] /.test(line);
    if (isPlan && (opensItem || HEADING.test(line))) insideClosedSprint = /^- \[x\] /.test(line);
    if (insideClosedSprint) return '';
    return CHECKBOX.test(line) && /^\s*- \[x\] /.test(line) ? '' : line;
  });
}

describe('QA-RET01 · el código ya no tiene rifas', () => {
  it('ni el código de la aplicación, ni el esquema, ni la semilla, ni los scripts, ni los datos de las pruebas de navegador las nombran', () => {
    const files = [
      ...filesUnder(path.join(ROOT, 'src'), ['.ts', '.tsx', '.css', '.json']),
      path.join(ROOT, 'schema', 'schema.prisma'),
      ...filesUnder(path.join(ROOT, 'prisma'), ['.ts']),
      ...filesUnder(path.join(ROOT, 'scripts'), ['.ts', '.mjs']),
      // Los datos que preparan las pruebas de navegador (un campo retirado en un borrador hace que el esquema estricto lo rechace antes de comprobar nada).
      ...readdirSync(path.join(ROOT, 'tests', 'e2e'))
        .filter((name) => /-support\.ts$|^journey-stages\.ts$|^helpers\.ts$/.test(name))
        .map((name) => path.join(ROOT, 'tests', 'e2e', name))
    ];
    expect(files.length).toBeGreaterThan(500);
    expect(hits(files)).toEqual([]);
  });

  it('el borrador del Estudio admite eventos y, desde el Sprint 5.14b, ventas de vales; la categoría fija es «Taquilla»; ninguna plantilla ofrece otra cosa', () => {
    expect(TICKETING_CATEGORY).toBe('Taquilla');
    expect(studioDraftSchema.shape.ticketSubtype.options).toEqual(['EVENT', 'VOUCHER']);
    expect(Object.keys(studioDraftSchema.shape).filter((key) => RAFFLE_WORDS.test(key))).toEqual([]);
    expect(CAMPAIGN_TEMPLATES.filter((template) => template.ticket !== undefined).every((template) => template.ticket!.subtype === 'EVENT')).toBe(true);
  });

  it('ni la auditoría, ni el expediente, ni los ajustes de la consola conservan acciones, avisos o campos de las rifas', () => {
    expect(AUDIT_ACTIONS.filter((action) => RAFFLE_WORDS.test(action))).toEqual([]);
    expect([...DOSSIER_EMAIL_TEMPLATE_KEYS].filter((key) => RAFFLE_WORDS.test(key))).toEqual([]);
    expect(Object.values(SECTION_FIELDS).flat().filter((field) => RAFFLE_WORDS.test(field.key))).toEqual([]);
    expect(Object.keys(SECTION_FIELDS)).not.toContain('limites');
  });

  it('la migración que las retira existe, es la última que toca sus tablas y conserva las guardas del libro mayor', () => {
    const migrations = readdirSync(path.join(ROOT, 'prisma', 'migrations')).filter((name) => /^\d{14}_/.test(name)).sort();
    const retirement = migrations.find((name) => name.endsWith('_retire_raffles'));
    expect(retirement).toBeDefined();
    const later = migrations.slice(migrations.indexOf(retirement!) + 1);
    for (const name of later) expect(readFileSync(path.join(ROOT, 'prisma', 'migrations', name, 'migration.sql'), 'utf8'), name).not.toMatch(/"Raffle(Draw|Number)"|rafflePrizeCount/);
    const sql = readFileSync(path.join(ROOT, 'prisma', 'migrations', retirement!, 'migration.sql'), 'utf8');
    expect(sql).toMatch(/DROP TABLE "RaffleDraw"/);
    expect(sql).toMatch(/DROP TABLE "RaffleNumber"/);
    expect(sql).not.toMatch(/LedgerJournal|EscrowLedgerEntry|AuditLog|DISABLE\s+TRIGGER/i);
  });
});

describe('QA-RET01 · los textos, las pruebas y la documentación ya no tienen rifas (Sprint 5.12b)', () => {
  it('ningún texto de los catálogos (castellano, catalán e inglés), ni su clave, habla de rifas, papeletas o sorteos', () => {
    for (const locale of ['es', 'ca', 'en']) {
      const entries = flatten(JSON.parse(readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8')) as CatalogNode);
      expect(entries.length, locale).toBeGreaterThan(3000);
      expect(entries.filter(([key, text]) => mentions(key, CATALOG_WORDS) || mentions(text, CATALOG_WORDS)).map(([key]) => `${locale}:${key}`)).toEqual([]);
      // Los textos que cambiaban con el tipo de taquilla (`{kind, select, …}`) ya no lo reciben: solo hay eventos.
      expect(entries.filter(([, text]) => /\{kind, select/.test(text)).map(([key]) => `${locale}:${key}`)).toEqual([]);
    }
  });

  it('ninguna prueba unitaria, de integración o de navegador las nombra, salvo las dos que vigilan la retirada', () => {
    const watchers = new Set(['tests/unit/raffle-retirement.spec.ts', 'tests/integration/raffle-retirement.spec.ts']);
    const files = filesUnder(path.join(ROOT, 'tests'), ['.ts', '.tsx', '.mjs']).filter((file) => !watchers.has(path.relative(ROOT, file).split(path.sep).join('/')));
    expect(files.length).toBeGreaterThan(150);
    expect(hits(files)).toEqual([]);
  });

  it('la documentación vigente (reglas, skills, agentes, documentos que mandan y textos legales) solo las nombra para decir que se retiraron', () => {
    const files = currentDocs();
    expect(files.length).toBeGreaterThan(50);
    const offending = files.flatMap((file) =>
      withoutClosedItems(file, readFileSync(file, 'utf8'))
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => mentions(line) && !RETIREMENT.test(line))
        .map(({ index }) => `${path.relative(ROOT, file).split(path.sep).join('/')}:${index + 1}`)
    );
    expect(offending).toEqual([]);
  });

  it('el índice del prototipo marca el sorteo como función retirada', () => {
    const anatomy = readFileSync(path.join(ROOT, '.agents', 'skills', 'korum-nextjs-multitenant-ui', 'references', 'korum-v8-anatomy.md'), 'utf8');
    expect(anatomy).toMatch(/función retirada/i);
  });
});
