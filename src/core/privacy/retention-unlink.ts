import { SECURITY_ACTIONS } from '@/core/audit/audit-catalog';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';
import { daysBefore, fiscalCutoff, lastExpiredFiscalYear, RETENTION } from './retention-policy';

/**
 * Pasos de `DATA_RETENTION_PURGE` que **desvinculan a una persona** de un registro que se conserva (Sprint 5.10b, tabla de plazos §3.1, §3.7, §3.9 y §3.10): la
 * anotación, el relevo, la votación o la aportación siguen, pero ya no dicen de qué cuenta eran. Nunca tocan un importe, un apunte contable ni una firma.
 *
 * - **Rastros de seguridad** (intentos fallidos de entrar y accesos denegados): a los 12 meses (decisión 35).
 * - **El resto de la auditoría, el historial de relevos, quién lanzó una votación y las aportaciones hechas con una cuenta:** a los 6 años desde el cierre del
 *   ejercicio. Las aportaciones de una aportación mensual siguen unidas a la cuenta mientras exista (§3.11).
 */

/** Marca de la cuenta a la que se refería una anotación (`targetType = 'User'`), una vez desvinculada. La guarda de la auditoría solo admite esta. */
export const UNLINKED_ACCOUNT = 'desvinculado';

/** Marcas de las tres cuentas de un relevo desvinculado: distintas, porque quien sale y quien entra no pueden coincidir (`SignerHandover_people_check`). */
export const UNLINKED_HANDOVER = { outgoingUserId: 'desvinculado:sale', incomingUserId: 'desvinculado:entra', proposedByUserId: 'desvinculado:propone', displayName: 'anonimizado' } as const;

/**
 * Claves de `metadataJson` que guardan el identificador de una cuenta. La guarda de la auditoría (migración `20261203090000_account_rights`) solo deja quitar
 * estas: una clave nueva con una cuenta dentro se añade aquí y allí a la vez. `tests/unit/retention-policy.spec.ts` busca en el código las claves que guardan
 * cuentas y `tests/integration/account-retention.spec.ts` comprueba que la guarda admite exactamente estas.
 */
export const AUDIT_PERSON_KEYS = ['by', 'signerUserId', 'removedCosignerUserId', 'triggeredByUserId', 'outgoingUserId'] as const;

/** Lo que aún dice de quién es una anotación: su autor, la cuenta a la que se refiere o una clave con una cuenta en sus detalles. */
const stillLinked: Prisma.AuditLogWhereInput = {
  OR: [
    { actorUserId: { not: null } },
    { targetType: 'User', NOT: { targetId: UNLINKED_ACCOUNT } },
    // Una clave de las de arriba con un texto (todas guardan el identificador de una cuenta): `string_starts_with ''` solo es cierto si la clave existe y es un texto.
    ...AUDIT_PERSON_KEYS.map((key) => ({ metadataJson: { path: [key], string_starts_with: '' } }))
  ]
};

function withoutPersonKeys(metadata: Prisma.JsonValue | null): Prisma.InputJsonValue | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const record = metadata as Prisma.JsonObject;
  if (!AUDIT_PERSON_KEYS.some((key) => key in record)) return undefined;
  const kept = Object.fromEntries(Object.entries(record).filter(([key]) => !(AUDIT_PERSON_KEYS as readonly string[]).includes(key)));
  return kept as Prisma.InputJsonObject;
}

async function unlinkAuditRows(db: Db, where: Prisma.AuditLogWhereInput, limit: number): Promise<number> {
  const rows = await db.auditLog.findMany({ where: { AND: [where, stillLinked] }, orderBy: { id: 'asc' }, take: limit, select: { id: true, targetType: true, metadataJson: true } });
  for (const row of rows) {
    const metadata = withoutPersonKeys(row.metadataJson);
    await db.auditLog.update({
      where: { id: row.id },
      data: { actorUserId: null, ...(row.targetType === 'User' ? { targetId: UNLINKED_ACCOUNT } : {}), ...(metadata !== undefined ? { metadataJson: metadata } : {}) }
    });
  }
  return rows.length;
}

/** Rastros de seguridad de más de 12 meses (tabla de plazos §3.10, decisión 35): la anotación se conserva, sin la cuenta. */
export async function unlinkOldSecurityTraces(db: Db, now: Date, limit: number): Promise<number> {
  return unlinkAuditRows(db, { action: { in: [...SECURITY_ACTIONS] }, occurredAt: { lt: daysBefore(now, RETENTION.securityTraceDays) } }, limit);
}

/** El resto de la auditoría, a los 6 años desde el cierre del ejercicio (§3.10): también los accesos del equipo de KORUM y las aperturas de documentos. */
export async function unlinkExpiredAuditRows(db: Db, now: Date, limit: number): Promise<number> {
  return unlinkAuditRows(db, { action: { notIn: [...SECURITY_ACTIONS] }, occurredAt: { lt: fiscalCutoff(now, RETENTION.fiscalYears) } }, limit);
}

/**
 * Historial de relevos de firmantes (§3.9): a los 6 años desde el cierre del ejercicio en que se cerró, se desvincula de las tres cuentas y se vacía el nombre que
 * escribió quien lo propuso. Uno abierto nunca tiene esa edad (caduca en 72 horas), pero no se toca.
 */
export async function unlinkExpiredHandovers(db: Db, now: Date, limit: number): Promise<number> {
  const cutoff = fiscalCutoff(now, RETENTION.fiscalYears);
  const rows = await db.signerHandover.findMany({
    where: {
      status: { notIn: ['AWAITING_CONSENT', 'INVITED'] },
      OR: [{ closedAt: { lt: cutoff } }, { closedAt: null, createdAt: { lt: cutoff } }],
      NOT: UNLINKED_HANDOVER
    },
    take: limit,
    select: { id: true }
  });
  if (rows.length === 0) return 0;
  const { count } = await db.signerHandover.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: UNLINKED_HANDOVER
  });
  return count;
}

/** Quién lanzó una votación de redimensionamiento (§3.7): como la auditoría, a los 6 años desde el cierre del ejercicio en que se lanzó. */
export async function unlinkExpiredPollCreators(db: Db, now: Date, limit: number): Promise<number> {
  const rows = await db.resizePoll.findMany({ where: { createdById: { not: null }, createdAt: { lt: fiscalCutoff(now, RETENTION.fiscalYears) } }, take: limit, select: { id: true } });
  // Una a una: la guarda de la votación solo admite vaciar `createdById` y nada más.
  for (const row of rows) await db.resizePoll.update({ where: { id: row.id }, data: { createdById: null } });
  return rows.length;
}

/**
 * Aportaciones hechas con una cuenta, de ejercicios vencidos (§3.1): dejan de estar unidas a ella; el importe, la fecha y el grupo se quedan. Los cobros de una
 * aportación mensual siguen unidos mientras la cuenta exista (§3.11): son el historial de la persona en *Mi cuenta*.
 */
export async function unlinkExpiredContributions(db: Db, now: Date, limit: number): Promise<number> {
  const rows = await db.contribution.findMany({ where: { fiscalYear: { lte: lastExpiredFiscalYear(now) }, userId: { not: null }, walletSubscriptionId: null }, take: limit, select: { id: true } });
  if (rows.length === 0) return 0;
  const { count } = await db.contribution.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { userId: null } });
  return count;
}
