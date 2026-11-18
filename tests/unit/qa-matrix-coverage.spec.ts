import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Sprint 5.6 · «100 % de la matriz». La regla de oro de `docs/QA_ACCEPTANCE_CRITERIA.md` dice que cada criterio `QA-*` se traduce en al menos una prueba
 * automatizada que queda en el repositorio. Esta prueba lo vigila: un criterio nuevo sin prueba, o una prueba que cita un criterio que ya no existe, hace
 * fallar la Puerta 2. Que cada prueba compruebe de verdad su criterio lo revisan los auditores; aquí se garantiza que ninguno se queda sin dueño.
 */

const ROOT = process.cwd();
const ID = /QA-[A-Z]+\d+/g;

/** Criterios que no se pueden automatizar en el repositorio, con su motivo. No se añade ninguno sin decirlo en la bitácora. */
const NOT_AUTOMATED: Record<string, string> = {
  'QA-OPS03': 'Lista de preproducción del Sprint 6.1: se recorre a mano sobre la infraestructura real (copias, DNS, sandbox de Paycomet).'
};

/**
 * Criterios con prueba, pero solo de una parte: qué falta y de qué depende. Se repasan al cerrar la tarea aplazada que los bloquea (y se anotan en la bitácora).
 */
const PARTIALLY_AUTOMATED: Record<string, string> = {
  'QA-P02':
    'La retirada de saldo en modo REGULATED_WALLET no tiene prueba: el monedero con saldo está aplazado (confirmación por escrito del proveedor y revisión legal, «Tareas externas aplazadas»). Sí se prueba que todo reembolso va al cobro original, que no existe ningún parámetro para un IBAN tecleado y que en PLEDGE no hay saldo que retirar.',
  'QA-X02':
    'La «navegación completa con teclado» se prueba en sus puntos de entrada (primer Tab, «Saltar al contenido», foco al cambiar de modo, al fallar un formulario y al abrir y cerrar diálogos) y axe vigila nombre, rol y foco visible en cada pantalla de las rutas públicas (3 idiomas), del recorrido de certificación y del panel en inglés. Un recorrido entero solo con teclado y con lector de pantalla (VoiceOver y TalkBack) se hace a mano: es la prueba aplazada por el promotor hasta el Sprint 6.2, antes de abrir el piloto a familias reales.'
};

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const matrix = readFileSync(path.join(ROOT, 'docs', 'QA_ACCEPTANCE_CRITERIA.md'), 'utf8');
/** Los criterios definidos: la primera celda de cada fila de la matriz, en negrita. */
const defined = [...matrix.matchAll(/^\| \*\*(QA-[A-Z]+\d+)\*\* \|/gm)].map((match) => match[1]!);
const citedBy = new Map<string, string[]>();
for (const file of testFiles(path.join(ROOT, 'tests'))) {
  if (file.endsWith('qa-matrix-coverage.spec.ts')) continue;
  for (const id of new Set(readFileSync(file, 'utf8').match(ID) ?? [])) citedBy.set(id, [...(citedBy.get(id) ?? []), path.relative(ROOT, file)]);
}

/**
 * Criterios de un sprint que todavía no se ha construido. La matriz los define por adelantado (su fila acaba con el sprint entre paréntesis: «(5.13)») y
 * su prueba llega con ese sprint. Mientras la ficha siga abierta en el plan (`- [ ]`) no se le exige prueba; **al marcarla `[x]`, la exigencia vuelve
 * sola** y un criterio sin prueba hace fallar la Puerta 2. Un sprint partido en entregas («5.12» con fichas 5.12a y 5.12b) cuenta como abierto mientras
 * quede alguna entrega abierta.
 */
const planText = readFileSync(path.join(ROOT, 'docs', 'PLAN_IMPLEMENTACION_ATOMICO.md'), 'utf8');
const sprintCards = [...planText.matchAll(/^- \[( |x)\] \*\*SPRINT (\d+\.\d+[a-z]?) —/gm)].map((match) => ({ id: match[2]!, open: match[1] === ' ' }));

function sprintIsOpen(sprint: string): boolean {
  const exact = sprintCards.filter((card) => card.id === sprint);
  if (exact.length > 0) return exact.some((card) => card.open);
  return sprintCards.some((card) => card.open && new RegExp(`^${sprint.replace('.', '\\.')}[a-z]$`).test(card.id));
}

const sprintOf = new Map<string, string[]>();
for (const row of matrix.matchAll(/^\| \*\*(QA-[A-Z]+\d+)\*\* \| ([^|]*)\|/gm)) {
  const closing = row[2]!.match(/\(([^()]*)\)\s*$/);
  const sprints = closing ? (closing[1]!.match(/\d+\.\d+[a-z]?/g) ?? []) : [];
  if (sprints.length > 0) sprintOf.set(row[1]!, sprints);
}
/** Pendiente de su sprint: todos los sprints que cita su fila siguen abiertos en el plan. */
const awaitsItsSprint = (id: string) => (sprintOf.get(id) ?? []).length > 0 && sprintOf.get(id)!.every(sprintIsOpen);

describe('matriz QA · cada criterio tiene su prueba', () => {
  it('la matriz define sus criterios una sola vez', () => {
    expect(defined.length).toBeGreaterThanOrEqual(60);
    expect(defined.filter((id, index) => defined.indexOf(id) !== index)).toEqual([]);
  });

  it('cada criterio lo nombra al menos una prueba del repositorio, salvo los de un sprint que aún no se ha construido', () => {
    const orphans = defined.filter((id) => !citedBy.has(id) && !(id in NOT_AUTOMATED) && !awaitsItsSprint(id));
    expect(orphans, 'criterios de la matriz sin ninguna prueba').toEqual([]);
  });

  it('un criterio solo espera a su sprint mientras la ficha de ese sprint sigue abierta en el plan', () => {
    const waiting = defined.filter((id) => !citedBy.has(id) && awaitsItsSprint(id));
    for (const id of waiting) {
      for (const sprint of sprintOf.get(id)!) {
        const known = sprintCards.some((card) => card.id === sprint || card.id.startsWith(sprint));
        expect(known, `${id} cita el sprint ${sprint}, que no tiene ficha en el plan`).toBe(true);
      }
    }
    // La regla no tapa nada de lo ya construido: un sprint cerrado no está «abierto» y uno partido lo está mientras quede una entrega.
    const closed = sprintCards.find((card) => !card.open);
    expect(closed).toBeDefined();
    expect(sprintIsOpen(closed!.id)).toBe(sprintCards.some((card) => card.id === closed!.id && card.open));
    expect(sprintIsOpen('0.0')).toBe(false);
  });

  it('las excepciones son solo las declaradas y siguen existiendo en la matriz', () => {
    expect(Object.keys(NOT_AUTOMATED).filter((id) => !defined.includes(id))).toEqual([]);
    expect(Object.keys(NOT_AUTOMATED).filter((id) => citedBy.has(id)), 'una excepción que ya tiene prueba deja de serlo').toEqual([]);
  });

  it('las coberturas parciales declaradas siguen en la matriz, con su prueba y con su motivo', () => {
    for (const [id, pending] of Object.entries(PARTIALLY_AUTOMATED)) {
      expect(defined, id).toContain(id);
      expect(citedBy.has(id), `${id} debe conservar la prueba de la parte que sí se cubre`).toBe(true);
      expect(pending.length, id).toBeGreaterThan(40);
    }
    // Las dos dependen de tareas que el plan sigue teniendo aplazadas: cuando dejen de estarlo, necesitan su prueba y salen de esta lista.
    const plan = readFileSync(path.join(ROOT, 'docs', 'PLAN_IMPLEMENTACION_ATOMICO.md'), 'utf8');
    expect(plan).toContain('REGULATED_WALLET');
    expect(plan).toContain('Prueba con lector de pantalla en móviles reales');
  });

  it('ninguna prueba cita un criterio que no está en la matriz', () => {
    expect([...citedBy.keys()].filter((id) => !defined.includes(id)).sort()).toEqual([]);
  });

  it('el plan y las fichas de los sprints solo citan criterios de la matriz', () => {
    const plan = readFileSync(path.join(ROOT, 'docs', 'PLAN_IMPLEMENTACION_ATOMICO.md'), 'utf8');
    expect([...new Set(plan.match(ID) ?? [])].filter((id) => !defined.includes(id)).sort()).toEqual([]);
  });

  it('la certificación del Sprint 5.6 tiene sus dos criterios: el recorrido completo y la intrusión entre entidades', () => {
    expect(citedBy.get('QA-X03')).toContain(path.join('tests', 'e2e', 'full-lifecycle-journey.spec.ts'));
    expect(citedBy.get('QA-SEC10')).toContain(path.join('tests', 'e2e', 'tenant-intrusion.spec.ts'));
  });
});
