import type { Db } from '@/lib/db';
import { reserveAttempt } from '@/lib/rate-limit';
import { ACCOUNT_PROBE_RULE } from '@/lib/rate-limit-rules';
import { loadAccountOwner, ownContributionsWhere } from '@/repositories/account.repository';
import { coarseUserAgent, type RequestMeta } from '@/repositories/tenant-guard';
import { writeAudit } from './audit.service';

/**
 * Intentos de tocar lo de otra persona desde *Mi cuenta* (Sprint 5.8a, deuda del 3.7). Las dos operaciones ya respondían bien (lo ajeno se trata igual que
 * lo que no existe), pero no dejaban rastro: quien recorría números de donación o identificadores de llave no aparecía en ninguna parte.
 *
 * - Solo se anota lo que **existe y es de otra persona**: un número que no existe no es de nadie, y una donación propia sin documento (devuelta) no es una
 *   intrusión. La respuesta a quien lo intenta no cambia: sigue sin poder distinguir lo ajeno de lo inexistente.
 * - Solo identificadores: la cuenta que lo intenta y el recurso. Ni el email ni la entidad de la otra persona.
 * - Las primeras de cada cuarto de hora por cuenta (`ACCOUNT_PROBE_RULE`): recorrer identificadores no llena la auditoría.
 * - Un fallo al anotar no cambia la respuesta: se registra en el servidor y la persona ve su «no encontrado» de siempre.
 */

interface Probe {
  userId: string;
  requestMeta?: RequestMeta;
}

async function recordProbe(db: Db, probe: Probe, action: 'account.certificate_denied' | 'account.passkey_delete_denied', targetType: 'Contribution' | 'Passkey', targetId: string, now: Date): Promise<boolean> {
  try {
    if (!(await reserveAttempt(db, `${ACCOUNT_PROBE_RULE.prefix}${probe.userId}`, ACCOUNT_PROBE_RULE, now))) return false;
    await writeAudit(db, {
      actorType: 'USER',
      actorUserId: probe.userId,
      action,
      targetType,
      targetId,
      ipHash: probe.requestMeta?.ipHash ?? null,
      userAgent: coarseUserAgent(probe.requestMeta?.userAgent),
      metadata: { reason: 'NOT_OWNER' }
    });
    return true;
  } catch (error) {
    console.error('No se pudo anotar el intento sobre un recurso ajeno', action, error);
    return false;
  }
}

/** La hoja de una donación que existe y no es de quien la pide. Devuelve si se anotó. */
export async function recordForeignCertificateAttempt(db: Db, probe: Probe, contributionId: number, now: Date = new Date()): Promise<boolean> {
  const exists = await db.contribution.findUnique({ where: { id: contributionId }, select: { id: true } });
  if (!exists) return false;
  const owner = await loadAccountOwner(db, probe.userId);
  const own = await db.contribution.findFirst({ where: { AND: [{ id: contributionId }, ownContributionsWhere(owner)] }, select: { id: true } });
  if (own) return false;
  return recordProbe(db, probe, 'account.certificate_denied', 'Contribution', String(contributionId), now);
}

/** Quitar una llave de acceso que existe y es de otra cuenta. Devuelve si se anotó. */
export async function recordForeignPasskeyAttempt(db: Db, probe: Probe, passkeyId: string, now: Date = new Date()): Promise<boolean> {
  const passkey = await db.passkey.findUnique({ where: { id: passkeyId }, select: { userId: true } });
  if (!passkey || passkey.userId === probe.userId) return false;
  return recordProbe(db, probe, 'account.passkey_delete_denied', 'Passkey', passkeyId.replace(/[^\x21-\x7e]/g, '?').slice(0, 120), now);
}
