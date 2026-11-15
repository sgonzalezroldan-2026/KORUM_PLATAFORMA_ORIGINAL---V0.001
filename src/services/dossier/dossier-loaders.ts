import { AUDIT_ACTIONS, PERSONAL_ACTIONS, READ_ACTIONS } from '@/core/audit/audit-catalog';
import {
  DOSSIER_AUDIT_LIMIT,
  DOSSIER_LEDGER_LIMIT,
  DOSSIER_MOVEMENT_LIMIT,
  type DossierActor,
  type DossierAuditRow,
  type DossierEmailGroup,
  type DossierJournal,
  type DossierLedger,
  type DossierScope,
  type DossierSignature
} from '@/core/dossier/dossier-model';
import { toSafeNumber } from '@/core/finance/ledger-balances';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';
import { loadEntityMembers } from '@/services/audit/audit-people';
import { searchAudit, type AuditFilters } from '@/services/audit/audit-viewer.service';
import { entityKindOf, groupEntityMovements } from './dossier-kinds';

/**
 * Piezas comunes del expediente exportable (Sprint 5.8b): libro mayor, firmas, emails y registro de actividad de un objeto. Solo lectura. Quien llama ya ha
 * pasado la guardia (`dossier.repository.ts`), trae la entidad dueña del objeto y lee dentro de una transacción de solo lectura (una misma foto de la base):
 * por eso aquí las consultas van una detrás de otra y ninguna pide más de una relación (Prisma cargaría dos a la vez sobre la misma conexión).
 *
 * Lo que cambia con el alcance:
 * - **Consola:** los asientos enteros, con todas sus cuentas y su pedido de Paycomet.
 * - **Entidad:** solo los apuntes de lo suyo (la hucha de la campaña y lo aprobado para enviarle), **sumados por tipo para toda la campaña**: ni el número de cada asiento
 *   (es común a toda la plataforma), ni la hora y el importe de cada aportación (dirían de quién es), ni nada que distinga el Auto-Impulso de una donación
 *   (Regla 02 §7), tampoco cuando KORUM lo recupera. Las firmas, solo con el nombre de quien firma hoy.
 */

/** Qué apuntes son de la entidad: la hucha de esa campaña y lo que se le debe a ella. Con el formato de la campaña, que decide cómo cuenta el Auto-Impulso. */
export interface OwnEntries {
  organizationId: string;
  initiativeId: number;
  format: string;
}

const ownEntryWhere = (own: OwnEntries): Prisma.EscrowLedgerEntryWhereInput => ({
  OR: [
    { account: 'INITIATIVE_ESCROW', initiativeId: own.initiativeId },
    { account: 'ORG_PAYABLE', organizationId: own.organizationId }
  ]
});

async function loadConsoleLedger(db: Db, where: Prisma.LedgerJournalWhereInput): Promise<DossierLedger> {
  const total = await db.ledgerJournal.count({ where });
  const found = await db.ledgerJournal.findMany({
    where,
    orderBy: { id: 'desc' },
    take: DOSSIER_LEDGER_LIMIT,
    select: { id: true, kind: true, occurredAt: true, paycometReference: true, reversesJournalId: true, entries: { orderBy: { id: 'asc' }, select: { account: true, direction: true, amountCents: true } } }
  });
  // De más antiguo a más reciente, como se lee un expediente.
  const journals: DossierJournal[] = found.reverse().map((row) => ({ id: row.id, kind: row.kind, occurredAt: row.occurredAt, reference: row.paycometReference, reversesId: row.reversesJournalId, entries: row.entries }));
  const unbalanced = journals.filter((journal) => journal.entries.reduce((sum, entry) => sum + (entry.direction === 'DEBIT' ? entry.amountCents : -entry.amountCents), 0) !== 0).length;
  return { journals, movements: [], movementsOmitted: false, totalJournals: total, unbalanced };
}

async function loadEntityLedger(db: Db, where: Prisma.LedgerJournalWhereInput, own: OwnEntries): Promise<DossierLedger> {
  const entryWhere: Prisma.EscrowLedgerEntryWhereInput = { AND: [ownEntryWhere(own), { journal: where }] };
  const total = await db.escrowLedgerEntry.count({ where: entryWhere });
  // Con más apuntes de los que se leen no se suma nada: una suma parcial, restada de las tablas (que cubren todo), dejaría justo los apuntes que faltan.
  if (total > DOSSIER_MOVEMENT_LIMIT) return { journals: [], movements: [], movementsOmitted: true, totalJournals: total, unbalanced: 0 };
  const entries = await db.escrowLedgerEntry.findMany({
    where: entryWhere,
    orderBy: { id: 'desc' },
    take: DOSSIER_MOVEMENT_LIMIT,
    select: { account: true, direction: true, amountCents: true, journal: { select: { kind: true, occurredAt: true, reversesJournal: { select: { kind: true } } } } }
  });
  const movements = groupEntityMovements(
    entries.reverse().map((entry) => ({ occurredAt: entry.journal.occurredAt, kind: entityKindOf(entry.journal.kind, entry.journal.reversesJournal?.kind ?? null, own.format), account: entry.account, direction: entry.direction, amountCents: entry.amountCents }))
  );
  for (const movement of movements) toSafeNumber(movement.totalCents);
  return { journals: [], movements, movementsOmitted: false, totalJournals: total, unbalanced: 0 };
}

export const loadDossierLedger = (db: Db, scope: DossierScope, where: Prisma.LedgerJournalWhereInput, own: OwnEntries): Promise<DossierLedger> =>
  scope === 'console' ? loadConsoleLedger(db, where) : loadEntityLedger(db, where, own);

/** Suma de los apuntes de esa cuenta y sentido en los asientos que cumplen `journal`. Sobre todo el libro, no sobre la lista del PDF. */
export async function sumLedgerEntries(db: Db, account: Prisma.EscrowLedgerEntryWhereInput['account'], direction: 'DEBIT' | 'CREDIT', journal: Prisma.LedgerJournalWhereInput): Promise<number> {
  const result = await db.escrowLedgerEntry.aggregate({ where: { ...(account ? { account } : {}), direction, journal }, _sum: { amountCents: true } });
  return toSafeNumber(result._sum.amountCents);
}

export async function loadDossierSignatures(db: Db, scope: DossierScope, organizationId: string, target: { ideaId: number | null; payoutId: number | null }): Promise<DossierSignature[]> {
  const or: Prisma.DoubleCheckSignatureWhereInput[] = [];
  if (target.ideaId !== null) or.push({ targetType: 'IDEA_APPROVAL', ideaId: target.ideaId });
  if (target.payoutId !== null) or.push({ targetType: 'ESCROW_PAYOUT', payoutId: target.payoutId });
  if (or.length === 0) return [];
  const rows = await db.doubleCheckSignature.findMany({
    where: { organizationId, OR: or },
    orderBy: { signedAt: 'asc' },
    select: { targetType: true, signerRole: true, signerUserId: true, signedAt: true, otpVerifiedAt: true, signatureHash: true, signer: { select: { name: true, gdprAnonymizedAt: true } } }
  });
  const members = scope === 'entity' ? await loadEntityMembers(db, organizationId) : [];
  const today = new Set(members.map((member) => member.userId));
  return rows.map((row) => ({
    target: row.targetType === 'IDEA_APPROVAL' ? 'IDEA_APPROVAL' : 'ESCROW_PAYOUT',
    role: row.signerRole,
    name: row.signer.gdprAnonymizedAt || !row.signer.name || (scope === 'entity' && !today.has(row.signerUserId)) ? null : row.signer.name,
    signedAt: row.signedAt,
    otpVerified: row.otpVerifiedAt !== null,
    hash: row.signatureHash
  }));
}

/**
 * Avisos que puede ver una entidad en su expediente: los dirigidos a ella, a quien firma por ella o a un comercio. Lista cerrada, como
 * `ENTITY_VISIBLE_ACTIONS`: una plantilla nueva no se enseña hasta añadirla aquí. Quedan fuera los que recibe cada familia (recibos, entradas, devoluciones,
 * certificados, avisos a quienes aportaron, votaciones y Mi Hucha): son de cada persona y, además, su número delataría el Auto-Impulso (un recibo menos que
 * donaciones), que para la entidad es una donación más (Regla 02 §7).
 */
export const ENTITY_EMAIL_TEMPLATES: readonly string[] = ['doubleCheck.pending', 'initiative.goalReached', 'initiative.expired', 'expired.decisionReminder', 'signer.handover', 'org.kybStatus', 'gate.pinRevoked'];
export const ENTITY_EMAIL_PREFIXES: readonly string[] = ['payout.', 'split.', 'sponsor.'];
const ENTITY_EMAILS: Prisma.OutboxMessageWhereInput = { OR: [{ templateKey: { in: [...ENTITY_EMAIL_TEMPLATES] } }, ...ENTITY_EMAIL_PREFIXES.map((prefix) => ({ templateKey: { startsWith: prefix } }))] };

/**
 * Emails de la bandeja de salida de la entidad que cumplen `where`, desde `since` (la creación de la campaña: acota la búsqueda), agrupados por plantilla y
 * estado. Nunca la dirección ni el contenido. En el expediente de la entidad solo entran los avisos de la lista cerrada `ENTITY_EMAIL_TEMPLATES`.
 */
export async function loadDossierEmails(db: Db, scope: DossierScope, organizationId: string, since: Date, where: Prisma.OutboxMessageWhereInput): Promise<DossierEmailGroup[]> {
  const groups = await db.outboxMessage.groupBy({
    by: ['templateKey', 'status'],
    where: { AND: [{ organizationId, createdAt: { gte: since } }, where, ...(scope === 'entity' ? [ENTITY_EMAILS] : [])] },
    _count: { _all: true },
    _min: { createdAt: true },
    _max: { createdAt: true }
  });
  return groups
    .flatMap((group) => (group._min.createdAt && group._max.createdAt ? [{ templateKey: group.templateKey, status: group.status, count: group._count._all, firstAt: group._min.createdAt, lastAt: group._max.createdAt }] : []))
    .sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime() || a.templateKey.localeCompare(b.templateKey));
}

/** Lo del Fondo de actividades: sus liquidaciones llevan su propio número en el mismo campo del detalle (`payoutId`) y son otra tabla. */
export const ACTIVITY_FUND_ACTIONS: readonly string[] = AUDIT_ACTIONS.filter((action) => action.startsWith('activity_fund.'));

/** Lo que no entra en el registro de un expediente de la consola: las lecturas (abrir, descargar: también los expedientes) y lo que cada persona hace con su cuenta. */
const CONSOLE_EXCLUDED_ACTIONS: readonly string[] = [...new Set([...READ_ACTIONS, ...PERSONAL_ACTIONS])];

/**
 * Registro de actividad del objeto, siempre de **esa entidad**. Las filas se buscan con el alcance de quien descarga (una entidad, exactamente lo que ve en
 * su panel; la consola, lo ocurrido en la entidad sin las consultas de KORUM, sin lecturas y sin acciones personales) y se pintan siempre como las ve una
 * entidad: sin emails, sin red ni dispositivo y con el nombre solo de quien firma hoy por ella.
 */
export async function loadDossierAudit(db: Db, scope: DossierScope, organizationId: string, filters: Pick<AuditFilters, 'initiativeId' | 'subject' | 'excludeActions'>): Promise<{ rows: DossierAuditRow[]; truncated: boolean }> {
  const excluded = filters.excludeActions ?? [];
  const page =
    scope === 'console'
      ? await searchAudit(db, { kind: 'console' }, { ...filters, organizationId, excludeActions: [...CONSOLE_EXCLUDED_ACTIONS, ...excluded] }, { pageSize: DOSSIER_AUDIT_LIMIT, presentAs: { organizationId } })
      : await searchAudit(db, { kind: 'entity', organizationId }, { ...filters, excludeActions: excluded }, { pageSize: DOSSIER_AUDIT_LIMIT });
  const rows = page.rows.map((row): DossierAuditRow => {
    const actor: DossierActor = row.actor.kind === 'member' ? { kind: 'member', name: row.actor.name, role: row.actor.role, roleLabel: row.actor.roleLabel } : row.actor.kind === 'person' ? { kind: 'other' } : { kind: row.actor.kind };
    return { occurredAt: row.occurredAt, action: row.action, actor, target: row.target, statusChange: row.statusChange };
  });
  return { rows: rows.reverse(), truncated: page.nextBefore !== null };
}
