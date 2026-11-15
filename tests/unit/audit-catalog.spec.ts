import { describe, expect, it } from 'vitest';
import ca from '../../messages/ca.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import {
  AUDIT_ACTION_PATTERN,
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_TARGET_KEYS,
  auditActionsOf,
  auditCategoryOf,
  auditTargetKeyOf,
  CONSOLE_ONLY_CATEGORIES,
  ENTITY_CATEGORIES,
  ENTITY_PROBE_ACTION,
  ENTITY_VISIBLE_ACTIONS,
  INITIATIVE_STATUSES,
  isKnownAuditAction,
  KORUM_DISCRETION_ACTIONS,
  KORUM_INTERNAL_ACTIONS,
  PERSONAL_ACTIONS,
  PROBE_ACTIONS,
  READ_ACTIONS,
  SECURITY_ACTIONS,
  STATUS_CHANGE_REASONS
} from '@/core/audit/audit-catalog';
import { activeAuditFilters, auditDateRange, auditQueryString, AUDIT_OPTION_MAX, distinctShortOptions, isCalendarDay, madridDayStart, parseAuditQuery, shortOption } from '@/core/audit/audit-query';
import { failedSignInIsNoteworthy } from '@/lib/auth/failed-sign-in';
import { auditDetailsOf } from '@/services/audit/audit-viewer.service';
import { REDACTED } from '@/services/audit/audit.service';

/**
 * Sprint 5.8a · visor de la auditoría (QA-SEC11). El catálogo de acciones es la única lista: cada acción tiene su texto en castellano, catalán e inglés, la
 * entidad solo ve una lista cerrada y los filtros de la dirección se validan sin romper la página.
 */

type Tree = { [key: string]: string | Tree };
const CATALOGS: Record<string, Tree> = { es: es.audit as Tree, ca: ca.audit as Tree, en: en.audit as Tree };

const leaf = (tree: Tree, dotted: string): unknown => dotted.split('.').reduce<unknown>((node, key) => (node !== null && typeof node === 'object' ? (node as Tree)[key] : undefined), tree);
const leaves = (tree: Tree, prefix = ''): string[] => Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [`${prefix}${key}`] : leaves(value, `${prefix}${key}.`)));

describe('catálogo de la auditoría', () => {
  it('no repite ninguna acción y todas tienen una forma que se puede buscar', () => {
    expect(AUDIT_ACTIONS.filter((action, index) => AUDIT_ACTIONS.indexOf(action) !== index)).toEqual([]);
    expect(AUDIT_ACTIONS.filter((action) => !AUDIT_ACTION_PATTERN.test(action))).toEqual([]);
    expect(AUDIT_ACTIONS.length).toBeGreaterThanOrEqual(180);
  });

  it('cada acción pertenece a una sola familia', () => {
    for (const category of AUDIT_CATEGORIES) for (const action of auditActionsOf(category)) expect(auditCategoryOf(action)).toBe(category);
    expect(auditCategoryOf('algo.que_no_existe')).toBeNull();
    expect(isKnownAuditAction('initiative.status_changed')).toBe(true);
  });

  it.each(Object.keys(CATALOGS))('cada acción tiene su texto en %s, y no sobra ninguno', (locale) => {
    const actions = CATALOGS[locale]!.actions as Tree;
    expect(AUDIT_ACTIONS.filter((action) => typeof leaf(actions, action) !== 'string' || (leaf(actions, action) as string).trim() === '')).toEqual([]);
    expect(leaves(actions).filter((key) => !isKnownAuditAction(key))).toEqual([]);
  });

  it.each(Object.keys(CATALOGS))('familias, tipos de objetivo, motivos y estados tienen texto en %s', (locale) => {
    const catalog = CATALOGS[locale]!;
    expect(Object.keys(catalog.categories as Tree).sort()).toEqual([...AUDIT_CATEGORIES, 'unclassified'].sort());
    expect(Object.keys(catalog.targets as Tree).sort()).toEqual([...AUDIT_TARGET_KEYS].sort());
    expect(Object.keys(catalog.reasons as Tree).sort()).toEqual([...STATUS_CHANGE_REASONS].sort());
    const statuses = ({ es, ca, en } as Record<string, { status: { initiative: Record<string, string> } }>)[locale]!.status.initiative;
    expect(INITIATIVE_STATUSES.filter((status) => !statuses[status])).toEqual([]);
  });

  it('ningún texto del visor lleva el código interno de una acción', () => {
    for (const catalog of Object.values(CATALOGS)) for (const action of AUDIT_ACTIONS) expect(leaf(catalog.actions as Tree, action)).not.toContain(action);
  });

  it('la entidad ve una lista cerrada: sin las consultas de KORUM, los ajustes de la plataforma ni las tareas automáticas', () => {
    expect([...CONSOLE_ONLY_CATEGORIES].sort()).toEqual(['korumAccess', 'platform', 'system']);
    for (const category of CONSOLE_ONLY_CATEGORIES) for (const action of auditActionsOf(category)) expect(ENTITY_VISIBLE_ACTIONS).not.toContain(action);
    expect(ENTITY_VISIBLE_ACTIONS).not.toContain('superadmin.access');
    expect(ENTITY_VISIBLE_ACTIONS).toEqual(expect.arrayContaining(['payout.approved', 'double_check.signed', 'initiative.status_changed', 'tenant.access_denied']));
    expect(ENTITY_CATEGORIES).not.toContain('platform');
    // Tampoco lo que una persona hace con su cuenta o con su aportación mensual, ni el Auto-Impulso de KORUM.
    for (const action of [...PERSONAL_ACTIONS, ...KORUM_DISCRETION_ACTIONS]) expect(ENTITY_VISIBLE_ACTIONS).not.toContain(action);
    expect(PERSONAL_ACTIONS).toEqual(expect.arrayContaining(['pledge.started', 'pledge.access_denied', 'account.passkey_added', 'privacy.export', 'auth.sign_in_failed_repeatedly']));
    expect(ENTITY_CATEGORIES).not.toContain('account');
    // Las lecturas y los sondeos existen en el catálogo y el visor los trata aparte.
    expect(READ_ACTIONS.every((action) => ENTITY_VISIBLE_ACTIONS.includes(action))).toBe(true);
    expect([...PROBE_ACTIONS].sort()).toEqual(['tenant.resource_not_found', 'tenant.resource_outside_tenant']);
    expect(PROBE_ACTIONS).toContain(ENTITY_PROBE_ACTION);
    // Ni la operación interna de KORUM con sus propias facturas.
    for (const action of KORUM_INTERNAL_ACTIONS) expect(ENTITY_VISIBLE_ACTIONS).not.toContain(action);
    expect(ENTITY_VISIBLE_ACTIONS).toEqual(expect.arrayContaining(['invoice.issued', 'invoice.rectified']));
    // Los avisos del 0 % son de campañas, no de seguridad.
    expect(auditCategoryOf('studio.semantic_lock_triggered')).toBe('campaigns');
    expect(SECURITY_ACTIONS).toContain('tenant.access_denied');
    expect(ENTITY_VISIBLE_ACTIONS.every(isKnownAuditAction)).toBe(true);
  });

  it('reconoce el tipo de objetivo aunque se haya escrito de otra manera', () => {
    expect(auditTargetKeyOf('EscrowPayout')).toBe('EscrowPayout');
    expect(auditTargetKeyOf('ESCROW_PAYOUT')).toBe('EscrowPayout');
    expect(auditTargetKeyOf('IDEA_APPROVAL')).toBe('IdeaApproval');
    expect(auditTargetKeyOf('AlgoNuevo')).toBeNull();
  });
});

describe('filtros del visor en la dirección', () => {
  it('acepta lo bien formado e ignora lo demás sin romper', () => {
    const query = parseAuditQuery({ familia: 'money', accion: 'payout.approved', persona: 'usr_123-AB', entidad: 'org_1', iniciativa: '42', desde: '2026-11-01', hasta: '2026-11-15', antes: '900' }, { allowUnclassified: true });
    expect(query).toEqual({ category: 'money', action: 'payout.approved', personUserId: 'usr_123-AB', organizationId: 'org_1', initiativeId: 42, fromDay: '2026-11-01', toDay: '2026-11-15', before: 900 });
    expect(activeAuditFilters(query)).toBe(7);

    const bad = parseAuditQuery({ familia: 'inventada', accion: "x'; drop table", persona: 'ana@ejemplo.com', entidad: '../otra', iniciativa: '-3', desde: '2026-02-31', hasta: 'ayer', antes: '99999999999' }, { allowUnclassified: true });
    expect(bad).toEqual({});
    expect(activeAuditFilters(bad)).toBe(0);
  });

  it('un email nunca pasa como filtro de persona', () => {
    expect(parseAuditQuery({ persona: 'laura@colegio.example' }, { allowUnclassified: true }).personUserId).toBeUndefined();
  });

  it('«sin clasificar» solo existe en la consola', () => {
    expect(parseAuditQuery({ familia: 'unclassified' }, { allowUnclassified: true }).category).toBe('unclassified');
    expect(parseAuditQuery({ familia: 'unclassified' }, { allowUnclassified: false }).category).toBeUndefined();
  });

  it('toma el primer valor de un parámetro repetido', () => {
    expect(parseAuditQuery({ iniciativa: ['7', '8'] }, { allowUnclassified: false }).initiativeId).toBe(7);
  });

  it('solo admite días reales del calendario', () => {
    expect(isCalendarDay('2028-02-29')).toBe(true);
    expect(isCalendarDay('2027-02-29')).toBe(false);
    expect(isCalendarDay('2026-13-01')).toBe(false);
    expect(isCalendarDay('1999-01-01')).toBe(false);
  });

  it('los días son los de España: invierno, verano y los dos cambios de hora', () => {
    expect(madridDayStart('2026-11-15').toISOString()).toBe('2026-11-14T23:00:00.000Z');
    expect(madridDayStart('2026-07-01').toISOString()).toBe('2026-06-30T22:00:00.000Z');
    // 29 de marzo de 2026: a las 02:00 pasan a ser las 03:00. El día empieza en horario de invierno y el siguiente, en el de verano.
    expect(madridDayStart('2026-03-29').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(madridDayStart('2026-03-29', 1).toISOString()).toBe('2026-03-29T22:00:00.000Z');
    // 25 de octubre de 2026: a las 03:00 vuelven a ser las 02:00.
    expect(madridDayStart('2026-10-25').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(madridDayStart('2026-10-25', 1).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(madridDayStart('2026-12-31', 1).toISOString()).toBe('2026-12-31T23:00:00.000Z');
  });

  it('«hasta el día 15» incluye todo el día 15', () => {
    const range = auditDateRange({ fromDay: '2026-11-15', toDay: '2026-11-15' });
    expect(range.from?.toISOString()).toBe('2026-11-14T23:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-11-15T23:00:00.000Z');
    expect(auditDateRange({})).toEqual({});
  });

  it('reconstruye la dirección de la misma búsqueda para paginar y para quitar un filtro', () => {
    const query = parseAuditQuery({ familia: 'money', persona: 'usr1', desde: '2026-11-01' }, { allowUnclassified: true });
    expect(auditQueryString(query, { before: 120 })).toBe('?familia=money&persona=usr1&desde=2026-11-01&antes=120');
    expect(auditQueryString(query, { personUserId: undefined })).toBe('?familia=money&desde=2026-11-01');
    expect(auditQueryString({})).toBe('');
  });
});

/** Distancia de edición entre dos textos (inserciones, borrados y sustituciones). */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}

describe('detalle guardado e inicios de sesión fallidos', () => {
  it('las opciones de un desplegable se recortan para que el navegador no las corte a medias', () => {
    expect(shortOption('Factura emitida')).toBe('Factura emitida');
    const long = shortOption('Aviso del 0 % tras publicar: una campaña parece hablar de obras o equipamiento');
    expect(long.length).toBeLessThanOrEqual(AUDIT_OPTION_MAX);
    expect(AUDIT_OPTION_MAX).toBeLessThanOrEqual(30);
    expect(long.endsWith('…')).toBe(true);
  });

  it('recorta por palabras completas, nunca a media palabra', () => {
    expect(shortOption('Enviada a revisión la documentación del titular')).toBe('Enviada a revisión la…');
    expect(shortOption('Liquidación: envío de dinero comprobado y resuelto a mano')).toBe('Liquidación: envío de dinero…');
    expect(shortOption('Privacidad: solicitud cerrada')).toBe('Privacidad: solicitud cerrada');
    // Sin signos colgando antes de los puntos suspensivos.
    expect(shortOption('Fondo de actividades: demasiados intentos')).toBe('Fondo de actividades…');
    // Una sola palabra larguísima se corta donde toque: no hay espacio al que volver.
    expect(shortOption('Supercalifragilisticoespialidosoyalgomas')).toHaveLength(AUDIT_OPTION_MAX);
  });

  it('los nombres que escribe la gente nunca dejan dos opciones iguales: conservan el final o llevan un número', () => {
    const schools = distinctShortOptions(['AMPA del CEIP Nuestra Señora de la Asunción y San José de Calasanz', 'AMPA del CEIP Nuestra Señora del Pilar', 'AMPA del CEIP Nuestra Señora del Carmen', 'Club Deportivo Sabadell']);
    expect(schools).toEqual(['AMPA del CEIP… de Calasanz', 'AMPA del CEIP… del Pilar', 'AMPA del CEIP… del Carmen', 'Club Deportivo Sabadell']);
    // Con el cargo delante, dos firmantes de nombre casi igual se distinguen.
    const signers = distinctShortOptions(['Presidencia del AMPA/AFA · María del Carmen Fernández de la Vega-Ruiz', 'Tesorería del AMPA/AFA · María del Carmen Fernández de Córdoba']);
    expect(new Set(signers).size).toBe(2);
    expect(signers[0]).toContain('Presidencia');
    expect(signers[1]).toContain('Tesorería');
    // Dos textos idénticos de verdad: un número delante.
    expect(distinctShortOptions(['Dirección · Ana', 'Dirección · Ana'])).toEqual(['1. Dirección · Ana', '2. Dirección · Ana']);
    // Siempre caben y nunca se repiten, tampoco con muchos nombres parecidos.
    const many = distinctShortOptions(Array.from({ length: 40 }, (_, index) => `Asociación de Madres y Padres del Colegio Público Número ${Math.floor(index / 2)} de Sabadell`));
    expect(new Set(many).size).toBe(40);
    expect(many.every((text) => text.length <= AUDIT_OPTION_MAX + 2)).toBe(true);
    expect(distinctShortOptions([])).toEqual([]);
  });

  it.each(Object.keys(CATALOGS))('recortadas, no hay dos acciones iguales en el desplegable (%s): cada texto empieza por lo que lo distingue', (locale) => {
    const actions = CATALOGS[locale]!.actions as Tree;
    const shown = AUDIT_ACTIONS.map((action) => shortOption(leaf(actions, action) as string));
    expect(shown.filter((text, index) => shown.indexOf(text) !== index)).toEqual([]);
    // Ni casi iguales: dos opciones que solo se diferencian en una o dos letras («envío…» / «envíos…») no se pueden elegir en un móvil, donde el texto
    // entero no se ve. Tienen que diferenciarse, como poco, en una palabra.
    const tooClose: string[] = [];
    for (let a = 0; a < shown.length; a += 1) for (let b = a + 1; b < shown.length; b += 1) if (editDistance(shown[a]!, shown[b]!) <= 2) tooClose.push(`${shown[a]} ≈ ${shown[b]}`);
    expect(tooClose).toEqual([]);
    // En el panel los dos sondeos son una sola opción, con su propio texto, que tampoco se confunde con ninguna otra de las que la entidad ve.
    const offered = ENTITY_VISIBLE_ACTIONS.filter((action) => !PROBE_ACTIONS.includes(action)).map((action) => shortOption(leaf(actions, action) as string));
    expect(offered).not.toContain(shortOption(leaf(CATALOGS[locale]!, 'entity.probe') as string));
  });

  it('vuelve a limpiar el detalle antes de enseñarlo: ni emails ni campos con nombre de dato personal', () => {
    const details = auditDetailsOf({ reason: 'NOT_OWNER', donorEmail: 'ana@ejemplo.com', note: 'escribir a ana@ejemplo.com', nested: { iban: 'ES9121000418450200051332', amountCents: 2500 } });
    const byKey = Object.fromEntries(details.map((detail) => [detail.key, detail.value]));
    expect(byKey.reason).toBe('NOT_OWNER');
    expect(byKey.donorEmail).toBe(REDACTED);
    expect(byKey.note).not.toContain('ana@ejemplo.com');
    expect(byKey.nested).toContain(REDACTED);
    expect(byKey.nested).not.toContain('ES91');
    expect(byKey.nested).toContain('2500');
    expect(auditDetailsOf(null)).toEqual([]);
    expect(auditDetailsOf(['a', 'b'])).toEqual([]);
  });

  it('un fallo suelto no se anota; al tercero sí, y después cada vez más espaciado: mil fallos dejan nueve filas', () => {
    const noted = Array.from({ length: 1000 }, (_, index) => index + 1).filter(failedSignInIsNoteworthy);
    expect(noted).toEqual([3, 8, 18, 38, 78, 158, 318, 638]);
    expect([0, -3, 2.5, Number.NaN].some(failedSignInIsNoteworthy)).toBe(false);
  });
});
