import { auditTargetKeyOf } from '@/core/audit/audit-catalog';
import type { Db } from '@/lib/db';
import type { AccountRow, AuditScope } from './audit-people';

/**
 * «Sobre qué» de cada registro del visor (Sprint 5.8a), pensado para quien lee y no para quien programa (revisión de experiencia del sprint):
 *
 * - Una campaña, un comercio o una idea se dicen con su número **y su nombre** («Campaña 12 · Toldos para el patio»). En el panel solo se resuelven los de
 *   la propia entidad: el número de una campaña ajena no trae su título.
 * - La entidad de la propia fila es solo «Entidad»; una cuenta, su nombre y su email en la consola y solo «Cuenta» en el panel.
 * - Los códigos internos que no dicen nada (identificadores largos de un relevo, de una sesión de portería, de un fichero; la ruta técnica de una subida
 *   denegada) no se enseñan en el panel: queda el tipo. La consola sí conserva los identificadores, que sirven para investigar, salvo las rutas técnicas.
 */

export interface AuditTargetView {
  type: string;
  id: string | null;
  /** Título de la campaña o de la idea, o nombre del comercio. */
  name: string | null;
}

interface RawTarget {
  targetType: string;
  targetId: string;
  organizationId: string | null;
}

const HIDDEN_IDS = new Set(['*', '', 'unknown']);
const NAME_MAX = 60;
const ID_MAX = 60;
/** Lo que una persona reconoce: un número («Liquidación 7») o un código corto en mayúsculas («TCK-AB12CD»). */
const READABLE_ID = /^(\d{1,10}|[A-Z]{2,5}-[A-Z0-9-]{3,20})$/;
const NUMERIC_ID = /^[1-9]\d{0,9}$/;
const MAX_INT = 2_147_483_647;

const NAMED = ['Initiative', 'Sponsor', 'Idea'] as const;
type NamedKey = (typeof NAMED)[number];
const namedKeyOf = (targetType: string): NamedKey | null => {
  const key = auditTargetKeyOf(targetType);
  return key !== null && (NAMED as readonly string[]).includes(key) ? (key as NamedKey) : null;
};

const clip = (text: string) => (text.length > NAME_MAX ? `${text.slice(0, NAME_MAX - 1).trimEnd()}…` : text);
const nameKey = (key: NamedKey, id: number) => `${key}:${id}`;

/** Nombres de las campañas, los comercios y las ideas que citan esas filas, en tres consultas como mucho. En el panel, solo los de su entidad. */
export async function loadTargetNames(db: Db, scope: AuditScope, rows: readonly RawTarget[]): Promise<Map<string, string>> {
  const ids: Record<NamedKey, Set<number>> = { Initiative: new Set(), Sponsor: new Set(), Idea: new Set() };
  for (const row of rows) {
    const key = namedKeyOf(row.targetType);
    if (key && NUMERIC_ID.test(row.targetId) && Number(row.targetId) <= MAX_INT) ids[key].add(Number(row.targetId));
  }
  const own = scope.kind === 'entity' ? { organizationId: scope.organizationId } : {};
  const [initiatives, sponsors, ideas] = await Promise.all([
    ids.Initiative.size > 0 ? db.initiative.findMany({ where: { id: { in: [...ids.Initiative] }, ...own }, select: { id: true, title: true } }) : [],
    ids.Sponsor.size > 0 ? db.sponsor.findMany({ where: { id: { in: [...ids.Sponsor] }, ...own }, select: { id: true, name: true } }) : [],
    ids.Idea.size > 0 ? db.idea.findMany({ where: { id: { in: [...ids.Idea] }, ...own }, select: { id: true, title: true } }) : []
  ]);
  const names = new Map<string, string>();
  for (const row of initiatives) if (row.title.trim()) names.set(nameKey('Initiative', row.id), clip(row.title.trim()));
  for (const row of sponsors) if (row.name.trim()) names.set(nameKey('Sponsor', row.id), clip(row.name.trim()));
  for (const row of ideas) if (row.title.trim()) names.set(nameKey('Idea', row.id), clip(row.title.trim()));
  return names;
}

export function auditTargetOf(row: RawTarget, scope: AuditScope, accounts: Map<string, AccountRow>, names: Map<string, string>): AuditTargetView {
  const type = row.targetType;
  const bare: AuditTargetView = { type, id: null, name: null };
  if (HIDDEN_IDS.has(row.targetId)) return bare;
  const key = auditTargetKeyOf(type);
  // La ruta técnica de una subida o una descarga denegada no le dice nada a nadie: el título del registro ya cuenta qué se intentó.
  if (key === 'Route') return bare;
  if (key === 'Organization' && (scope.kind === 'entity' || row.targetId === row.organizationId)) return bare;
  if (key === 'User') {
    if (scope.kind === 'entity') return bare;
    const account = accounts.get(row.targetId);
    if (!account || account.gdprAnonymizedAt) return bare;
    return { type, id: account.name ? `${account.name} (${account.email})` : account.email, name: null };
  }
  // El número interno de una factura de KORUM es común a toda la plataforma: en el panel diría cuánto factura KORUM.
  if (scope.kind === 'entity' && (key === 'Invoice' || !READABLE_ID.test(row.targetId))) return bare;
  const named = namedKeyOf(type);
  const name = named && NUMERIC_ID.test(row.targetId) ? (names.get(nameKey(named, Number(row.targetId))) ?? null) : null;
  return { type, id: row.targetId.slice(0, ID_MAX), name };
}
