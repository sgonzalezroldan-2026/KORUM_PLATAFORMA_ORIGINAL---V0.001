import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { recordStatusChange } from '@/services/audit/status-change-audit';

/**
 * Sprint 5.8a · cada cambio de estado de una iniciativa deja su rastro con el motivo (QA-SEC12). Además de probar la fila que se escribe, esta prueba lee
 * el código y falla si aparece un cambio de estado sin su rastro:
 *
 * 1. Toda escritura de `Initiative.status` con el cliente (`update`, `updateMany`, `upsert`), sea un estado literal, una variable o la forma abreviada
 *    (`data: { status }`), tiene que ir seguida de cerca por su `recordStatusChange(` (no vale que el archivo lo llame en otro sitio).
 * 2. No se admite ninguna otra forma de cambiarlo: ni escrituras anidadas desde otro modelo (`initiative: { update … status }`), ni SQL directo sobre la tabla.
 * 3. Una escritura cuyos datos no se pueden leer aquí (una variable, una función, una propagación `...`) solo se admite si está en la lista de excepciones,
 *    con su motivo: quien añada otra tiene que mirar si cambia el estado.
 *
 * La semilla y los datos de demostración quedan fuera: crean las campañas ya en su estado, no las cambian.
 */

const SRC = path.join(process.cwd(), 'src');
/** Cuánto puede separarse la escritura de su rastro: lo que ocupa terminar la llamada y, como mucho, una comprobación del resultado. */
const NEARBY = 900;
/** Operaciones del cliente que escriben una iniciativa ya existente. */
const OPERATION = String.raw`\.initiative\.(?:update|updateMany|updateManyAndReturn|upsert)\(`;
const WRITE = String.raw`${OPERATION}\{[^;]*?\b(?:data|update):\s*`;
/** La clave `status` de un objeto, también entre comillas (tras `{` o `,`), no un valor que se llame así (`indexNowStatus: status`). */
const STATUS_KEY = String.raw`[{,]\s*['"]?status['"]?\s*(?::\s*(?!true\b)[^\s,}]|[,}])`;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' || entry.name === 'seed' || entry.name === 'mocks' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Escrituras de estado en un texto de código, dentro de la misma sentencia (`[^;]`): `status: <valor>` (literal o variable) o la forma abreviada
 * (`status,` / `status }`). `status: true` es un `select`, no una escritura. Devuelve la posición de cada una.
 */
function statusWrites(code: string): number[] {
  const pattern = new RegExp(String.raw`${WRITE}(?=\{)[^;]*?${STATUS_KEY}`, 'g');
  return [...code.matchAll(pattern)].map((match) => match.index + match[0].length);
}

const hasRecordNearby = (code: string, position: number) => code.slice(position, position + NEARBY).includes('recordStatusChange(');

/** Otras formas de cambiar el estado, que no se admiten: escritura anidada desde otro modelo o SQL directo. */
function forbiddenStatusWrites(code: string): string[] {
  const found: string[] = [];
  if (new RegExp(String.raw`\binitiatives?:\s*\{\s*(?:update|updateMany|upsert)\b[^;]*?${STATUS_KEY}`).test(code)) found.push('escritura anidada del estado desde otro modelo');
  if (/UPDATE\s+"?(?:\w+"?\.)?"?Initiative"?\s+SET[^;`]*"?status"?\s*=/i.test(code)) found.push('SQL directo sobre el estado');
  return found;
}

/**
 * Escrituras de una iniciativa cuyos datos no son un objeto escrito ahí mismo (`data: patch`, `data: columnas(borrador)`, `data: cond ? a : b`), que
 * propagan otro objeto (`data: { ...patch }`) o cuyos argumentos enteros vienen en una variable (`update(args)`): desde aquí no se puede saber si tocan
 * el estado.
 */
function opaqueWrites(code: string): number {
  const notLiteral = code.match(new RegExp(String.raw`${WRITE}(?![\s{])`, 'g'))?.length ?? 0;
  // Una propagación dentro del propio objeto de datos (a su nivel o tras un valor anidado de un nivel), no en el resto de la llamada.
  const spread = code.match(new RegExp(String.raw`${WRITE}\{(?:[^{};]|\{[^{};]*\})*?\.\.\.`, 'g'))?.length ?? 0;
  // Los argumentos enteros en una variable o en una llamada: ni siquiera se ve si hay `data`.
  const wholeArgument = code.match(new RegExp(String.raw`${OPERATION}\s*(?![\s{])`, 'g'))?.length ?? 0;
  // La forma abreviada (`update({ where, data })`, `upsert({ where, create, update })`): los datos están en una variable.
  const shorthand = code.match(new RegExp(String.raw`${OPERATION}\{[^;]*?[{,]\s*(?:data|update)\s*[,}]`, 'g'))?.length ?? 0;
  // Una propagación entre los propios argumentos (`update({ where: { id }, ...cambio })`).
  const spreadArguments = code.match(new RegExp(String.raw`${OPERATION}\{(?:[^{};]|\{[^{};]*\})*?\.\.\.`, 'g'))?.length ?? 0;
  return notLiteral + spread + wholeArgument + shorthand + spreadArguments;
}

/** Las únicas escrituras opacas admitidas, revisadas una a una: ninguna toca el estado. */
const OPAQUE_ALLOWED: Record<string, { count: number; why: string }> = {
  'src/services/panel/studio.service.ts': { count: 2, why: 'Guardar un borrador (`softColumns` y `pricingColumns`: texto, reto, placa y cifras del presupuesto) y los cambios sin dinero de una campaña publicada (`softColumns`).' },
  'src/services/sponsors/sponsor-money.ts': { count: 2, why: 'Al sacar a un comercio de su campaña de origen: apaga su bolsa Matching o baja lo recaudado y, si procede, el contador de aportaciones.' },
  'src/services/storage/achievement-photos.service.ts': { count: 1, why: 'Guarda la foto del Antes o la del Después.' }
};

const files = sourceFiles(SRC).map((file) => ({ file: path.relative(process.cwd(), file).replace(/\\/g, '/'), code: readFileSync(file, 'utf8') }));

describe('rastro de los cambios de estado de una iniciativa', () => {
  const writers = files.map((entry) => ({ ...entry, writes: statusWrites(entry.code) })).filter((entry) => entry.writes.length > 0);

  it('encuentra los sitios que cambian el estado (si no, la búsqueda se ha roto)', () => {
    expect(writers.map((entry) => entry.file).sort()).toEqual(
      [
        'src/core/finance/campaign-window.ts',
        'src/core/jobs/handlers/campaign-expiry.ts',
        'src/core/jobs/handlers/mass-refund.ts',
        'src/core/ticketing/event-date-reached.ts',
        'src/core/ticketing/held-event.ts',
        'src/core/ticketing/voucher-sale-close.ts',
        'src/services/panel/studio.service.ts',
        'src/services/payments/campaign-close.ts',
        'src/services/payments/goal-reached.ts',
        'src/services/payments/moved-sponsor-reversals.ts',
        'src/services/payments/payment-reversals.ts',
        'src/services/resize/expired-decision.service.ts',
        'src/services/resize/resize-close.ts',
        'src/services/resize/resized-loss.ts',
        'src/services/ticketing/event-schedule.service.ts',
        'src/services/ticketing/voucher-sale.service.ts'
      ].sort()
    );
    expect(writers.reduce((sum, entry) => sum + entry.writes.length, 0)).toBe(20);
  });

  it('cada cambio de estado lleva su recordStatusChange justo después, no en otra parte del archivo', () => {
    const missing = writers.flatMap((entry) => entry.writes.filter((position) => !hasRecordNearby(entry.code, position)).map((position) => `${entry.file}: ${entry.code.slice(Math.max(0, position - 80), position).replace(/\s+/g, ' ')}`));
    expect(missing).toEqual([]);
  });

  it('nadie cambia el estado por otra vía: ni escrituras anidadas ni SQL directo', () => {
    expect(files.flatMap((entry) => forbiddenStatusWrites(entry.code).map((problem) => `${entry.file}: ${problem}`))).toEqual([]);
  });

  it('una escritura cuyos datos no se leen aquí solo se admite si está en la lista de excepciones revisadas', () => {
    const opaque = Object.fromEntries(files.map((entry) => [entry.file, opaqueWrites(entry.code)] as const).filter(([, count]) => count > 0));
    expect(opaque).toEqual(Object.fromEntries(Object.entries(OPAQUE_ALLOWED).map(([file, { count }]) => [file, count])));
    expect(Object.values(OPAQUE_ALLOWED).every(({ why }) => why.length > 20)).toBe(true);
  });

  it('la búsqueda reconoce las formas de burlarla y no confunde una lectura con una escritura', () => {
    // Un estado en una variable, la forma abreviada, un `upsert` y una escritura de varias líneas.
    expect(statusWrites('await tx.initiative.update({ where: { id }, data: { status: next } });')).toHaveLength(1);
    expect(statusWrites('await tx.initiative.update({ where: { id }, data: { status, stepIndex: 4 } });')).toHaveLength(1);
    expect(statusWrites('await tx.initiative.update({ where: { id }, data: { stepIndex: 4, status } });')).toHaveLength(1);
    expect(statusWrites("await tx.initiative.updateMany({ where: { id, status: 'EXPIRED' }, data: { stepIndex: 2, status: target.status } });")).toHaveLength(1);
    expect(statusWrites("await db.initiative.upsert({ where: { id }, create: base, update: { status: 'CLOSED' } });")).toHaveLength(1);
    expect(statusWrites("await tx.initiative.update({\n  where: { id },\n  data: {\n    goalCents,\n    status: 'GOAL_REACHED'\n  }\n});")).toHaveLength(1);
    // El rastro lejos, o en otra función, no vale.
    const far = `await tx.initiative.update({ where: { id }, data: { status: 'CLOSED' } });\n${'// relleno\n'.repeat(120)}await recordStatusChange(tx, change);`;
    expect(hasRecordNearby(far, statusWrites(far)[0]!)).toBe(false);
    // Lecturas y condiciones: no son cambios.
    expect(statusWrites('await tx.initiative.update({ where: { id }, data: { raisedCents: { decrement: 5 } }, select: { status: true, goalCents: true } });')).toEqual([]);
    expect(statusWrites("await tx.initiative.updateMany({ where: { id, status: 'BUDGETING' }, data: { updatedAt: now } });")).toEqual([]);
    expect(statusWrites("await tx.initiative.findMany({ where: { status: 'REFUNDING' } });")).toEqual([]);
    expect(statusWrites('await db.initiative.updateMany({ where: { id: { in: ids }, status }, data: { indexNowStatus: status } });')).toEqual([]);
    // Las tres formas que se le escapaban a la primera versión de esta búsqueda (auditoría de seguridad, tercera pasada).
    expect(statusWrites("await tx.initiative.updateManyAndReturn({ where: { id }, data: { status: 'CLOSED' } });")).toHaveLength(1);
    expect(statusWrites("await tx.initiative.update({ where: { id }, data: { 'status': 'CLOSED' } });")).toHaveLength(1);
    expect(statusWrites('await tx.initiative.update({ where: { id }, data: { stepIndex: 6, "status": next } });')).toHaveLength(1);
    expect(opaqueWrites("const args = { where: { id }, data: { status: 'CLOSED' } };\nawait tx.initiative.update(args);")).toBe(1);
    expect(opaqueWrites('await tx.initiative.updateManyAndReturn(build(id));')).toBe(1);
    // La forma abreviada, que este código usa con otros modelos (auditoría de seguridad, cuarta pasada).
    expect(opaqueWrites("const data = { status: 'CLOSED' as const };\nawait tx.initiative.update({ where: { id }, data });")).toBe(1);
    expect(opaqueWrites('await db.initiative.upsert({ where, create, update });')).toBe(1);
    expect(opaqueWrites('await tx.initiative.update({ where: { id }, ...cambio });')).toBe(1);
    // Datos que no se pueden leer: cuentan como opacos.
    expect(opaqueWrites('await tx.initiative.update({ where: { id }, data: patch });')).toBe(1);
    expect(opaqueWrites('await tx.initiative.update({ where: { id }, data: { ...patch } });')).toBe(1);
    expect(opaqueWrites('await tx.initiative.updateMany({ where: { id }, data: build(draft) });')).toBe(1);
    expect(opaqueWrites('await tx.initiative.update({ where: { id }, data: { stepIndex: 4 } });')).toBe(0);
    // Las vías que no se admiten.
    expect(forbiddenStatusWrites("await tx.contribution.update({ where: { id }, data: { initiative: { update: { status: 'CLOSED' } } } });")).toHaveLength(1);
    expect(forbiddenStatusWrites('await tx.contribution.update({ where: { id }, data: { initiative: { update: { status } } } });')).toHaveLength(1);
    expect(forbiddenStatusWrites('await db.$executeRaw`UPDATE "Initiative" SET status = \'CLOSED\' WHERE id = ${id}`;')).toHaveLength(1);
    expect(forbiddenStatusWrites("await tx.sponsor.update({ where: { id }, data: { status: 'REFUNDED' } });")).toEqual([]);
  });

  it('escribe quién, de qué estado a cuál y por qué, sin más datos', async () => {
    const create = vi.fn().mockResolvedValue({});
    await recordStatusChange({ auditLog: { create } } as never, { initiativeId: 7, organizationId: 'org_1', from: 'FUNDRAISING', to: 'EXPIRED', reason: 'DEADLINE_PASSED' });
    expect(create).toHaveBeenCalledWith({
      data: { actorType: 'SYSTEM', actorUserId: null, organizationId: 'org_1', action: 'initiative.status_changed', targetType: 'Initiative', targetId: '7', metadataJson: { initiativeId: 7, from: 'FUNDRAISING', to: 'EXPIRED', reason: 'DEADLINE_PASSED' } }
    });
    await recordStatusChange({ auditLog: { create } } as never, { initiativeId: 8, organizationId: 'org_1', from: 'BUDGETING', to: 'FUNDRAISING', reason: 'PUBLISHED', actorUserId: 'usr_9' });
    expect(create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ actorType: 'USER', actorUserId: 'usr_9' }) });
    // Lo que desencadenó una cuenta de KORUM queda como del sistema; quién fue, solo en el detalle.
    await recordStatusChange({ auditLog: { create } } as never, { initiativeId: 9, organizationId: 'org_1', from: 'FUNDRAISING', to: 'GOAL_REACHED', reason: 'GOAL_REACHED', triggeredByUserId: 'usr_korum' });
    expect(create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ actorType: 'SYSTEM', actorUserId: null, metadataJson: expect.objectContaining({ triggeredByUserId: 'usr_korum' }) }) });
  });
});
