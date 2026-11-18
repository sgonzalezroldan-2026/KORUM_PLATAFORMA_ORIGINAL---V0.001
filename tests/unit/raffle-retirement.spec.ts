import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@/core/audit/audit-catalog';
import { DOSSIER_EMAIL_TEMPLATE_KEYS } from '@/core/dossier/dossier-texts';
import { SECTION_FIELDS } from '@/core/admin/settings-model';
import { CAMPAIGN_TEMPLATES } from '@/core/studio/campaign-templates';
import { studioDraftSchema, TICKETING_CATEGORY } from '@/core/studio/studio-draft';

/**
 * QA-RET01 · Retirada de las rifas, primera entrega (Sprint 5.12a: motor, datos y pruebas). El código de la aplicación, el esquema, la semilla y los scripts
 * ya no hablan de rifas, papeletas ni sorteos. Las migraciones antiguas son historia (no se reescriben) y la que las retira las nombra; los catálogos de
 * textos, las pruebas que los leen y la documentación los limpia el Sprint 5.12b, que amplía esta prueba.
 */

const ROOT = process.cwd();
const RAFFLE_WORDS = /raffle|(?<![a-záéíóúñ])rifas?(?![a-záéíóúñ])|papeleta|sorteo|sorteig|butllet/i;

function filesUnder(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return name === 'generated' ? [] : filesUnder(full, extensions);
    return extensions.some((extension) => name.endsWith(extension)) ? [full] : [];
  });
}

const hits = (files: string[]) =>
  files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line, index) => ({ line, index }))
      // «Veri*factu» contiene «rifa» en mayúsculas y no tiene nada que ver.
      .filter(({ line }) => RAFFLE_WORDS.test(line.replace(/verifactu/gi, '')))
      .map(({ index }) => `${path.relative(ROOT, file)}:${index + 1}`)
  );

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

  it('el borrador del Estudio solo admite eventos y la categoría fija es «Taquilla»; ninguna plantilla ofrece otra cosa', () => {
    expect(TICKETING_CATEGORY).toBe('Taquilla');
    expect(studioDraftSchema.shape.ticketSubtype.options).toEqual(['EVENT']);
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
