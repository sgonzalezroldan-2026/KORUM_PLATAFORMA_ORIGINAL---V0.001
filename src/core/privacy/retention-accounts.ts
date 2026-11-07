import { raiseAlert, resolveAlert, resolveAlertsNotIn } from '@/core/jobs/ops-alerts';
import type { Keyring } from '@/core/security/crypto';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';
import type { PaymentProvider } from '@/services/payments/payment-provider';
import type { StorageProvider } from '@/services/storage/storage-provider';
import { deleteCardsOf, erasePersonalData, ErasureBlockedError, type ErasureDeps } from './erasure.service';
import { overduePrivacyRequests } from './privacy-requests';
import { daysBefore, RETENTION } from './retention-policy';

/**
 * Pasos de `DATA_RETENTION_PURGE` que necesitan algo más que la base: cuentas sin actividad (aviso por email y supresión), tarjetas cuyo
 * borrado en Paycomet quedó pendiente, ficheros con el plazo legal vencido y solicitudes RGPD fuera de plazo.
 */

/** Plantilla del aviso de inactividad (catálogo de EXPERIENCIA_DE_PRODUCTO §4; el envío es del Sprint 2.6). */
export const INACTIVITY_NOTICE_TEMPLATE = 'privacy.inactivityNotice';

/**
 * Cuenta que se puede tratar como inactiva: ni Super-Admin, ni firmante, ni con saldo, ni con una aportación mensual en marcha (sería
 * terminar un compromiso vivo), ni con aportaciones con la cuenta en los últimos 3 años. Las compras como invitada se miran aparte.
 */
function inactiveCandidate(now: Date): Prisma.UserWhereInput {
  const since = daysBefore(now, RETENTION.inactiveAccountDays);
  return {
    gdprAnonymizedAt: null,
    isSuperadmin: false,
    walletBalanceCents: 0,
    lastActiveAt: { lt: since },
    memberships: { none: { role: { in: [...SIGNER_ROLES] } } },
    walletSubscriptions: { none: { status: { in: ['ACTIVE', 'PAUSED'] } } },
    contributions: { none: { createdAt: { gte: since } } }
  };
}

/** De una lista de cuentas, las que compraron como invitadas con su email (verificado) en los últimos 3 años: siguen activas. */
async function recentGuestBuyers(db: Db, users: Array<{ canonicalEmail: string; emailVerified: boolean }>, now: Date): Promise<Set<string>> {
  const emails = users.filter((user) => user.emailVerified).map((user) => user.canonicalEmail);
  if (emails.length === 0) return new Set();
  const rows = await db.contribution.findMany({ where: { canonicalEmail: { in: emails }, createdAt: { gte: daysBefore(now, RETENTION.inactiveAccountDays) } }, distinct: ['canonicalEmail'], select: { canonicalEmail: true } });
  return new Set(rows.map((row) => row.canonicalEmail!));
}

/** Cuentas sin actividad en 3 años: se escribe el aviso en la bandeja de salida y se anota la fecha. La supresión llega 30 días después. */
export async function noticeInactiveAccounts(db: Db, now: Date, limit: number): Promise<number> {
  const found = await db.user.findMany({ where: { ...inactiveCandidate(now), inactivityNoticeAt: null }, orderBy: { id: 'asc' }, take: limit, select: { id: true, email: true, canonicalEmail: true, emailVerified: true, locale: true, lastActiveAt: true } });
  const active = await recentGuestBuyers(db, found, now);
  const users = found.filter((user) => !active.has(user.canonicalEmail));
  if (users.length === 0) return 0;
  const eraseOn = new Date(now.getTime() + RETENTION.inactivityGraceDays * 86_400_000).toISOString();
  await db.outboxMessage.createMany({
    data: users.map((user) => ({
      idempotencyKey: `${INACTIVITY_NOTICE_TEMPLATE}:${user.id}:${user.lastActiveAt.toISOString()}`,
      templateKey: INACTIVITY_NOTICE_TEMPLATE,
      locale: user.locale,
      toAddress: user.email,
      userId: user.id,
      payloadJson: { eraseOn }
    })),
    skipDuplicates: true
  });
  const { count } = await db.user.updateMany({ where: { id: { in: users.map((user) => user.id) }, inactivityNoticeAt: null }, data: { inactivityNoticeAt: now } });
  return count;
}

export interface InactivityErasureResult {
  erased: number;
  /** Volvieron, o dejaron de ser candidatas (cargo, aportación mensual, compra), después del aviso: el aviso deja de contar. */
  returned: number;
  /** Fallaron por un error inesperado: alerta y reintento la semana siguiente; las demás siguen. */
  failed: number;
}

/** Cuentas avisadas hace más de 30 días que siguen inactivas: se suprimen. Las que volvieron pierden el aviso. */
export async function eraseUnresponsiveAccounts(db: Db, deps: ErasureDeps, now: Date, limit: number, deadline?: number): Promise<InactivityErasureResult> {
  const result: InactivityErasureResult = { erased: 0, returned: 0, failed: 0 };
  const noticed = await db.user.findMany({ where: { gdprAnonymizedAt: null, inactivityNoticeAt: { not: null } }, orderBy: { id: 'asc' }, take: limit, select: { id: true, canonicalEmail: true, emailVerified: true, lastActiveAt: true, inactivityNoticeAt: true } });
  if (noticed.length === 0) return result;
  const stillInactive = new Set((await db.user.findMany({ where: { id: { in: noticed.map((user) => user.id) }, ...inactiveCandidate(now) }, select: { id: true } })).map((user) => user.id));
  const guestBuyers = await recentGuestBuyers(db, noticed, now);
  const graceStart = daysBefore(now, RETENTION.inactivityGraceDays);
  for (const user of noticed) {
    if (deadline !== undefined && Date.now() > deadline) break;
    const noticeAt = user.inactivityNoticeAt!;
    if (user.lastActiveAt > noticeAt || !stillInactive.has(user.id) || guestBuyers.has(user.canonicalEmail)) {
      await db.user.updateMany({ where: { id: user.id, inactivityNoticeAt: noticeAt }, data: { inactivityNoticeAt: null } });
      result.returned += 1;
      continue;
    }
    if (noticeAt >= graceStart) continue;
    try {
      await erasePersonalData(db, deps, { userId: user.id, requestedBy: { kind: 'system', reason: 'INACTIVITY' } }, now);
      result.erased += 1;
      await resolveAlert(db, `inactive-erasure:${user.id}`, now);
    } catch (error) {
      if (error instanceof ErasureBlockedError) {
        // Se convirtió en firmante entre la consulta y la supresión: deja de ser candidata.
        await db.user.updateMany({ where: { id: user.id, inactivityNoticeAt: noticeAt }, data: { inactivityNoticeAt: null } });
        result.returned += 1;
        continue;
      }
      result.failed += 1;
      await raiseAlert(db, { type: 'PRIVACY_ERASURE_FAILED', severity: 'WARNING', dedupeKey: `inactive-erasure:${user.id}`, targetType: 'User', targetId: user.id, detail: { userId: user.id, error: error instanceof Error ? error.name : 'Error' } }, now);
    }
  }
  return result;
}

/** Tarjetas revocadas que Paycomet aún no confirmó borrar: de cuentas suprimidas o de aportaciones de Mi Hucha ya terminadas o canceladas. Paycomet caído o sin configurar no rompe la tarea. */
export async function retryCardDeletions(db: Db, deps: { paymentProvider: () => Promise<PaymentProvider>; keyring: Keyring }, now: Date, limit: number): Promise<{ deleted: number; failed: number }> {
  const pending = await db.paymentMethodToken.findMany({ where: { providerDeletedAt: null, revokedAt: { not: null }, NOT: { idUserEnc: '' }, OR: [{ user: { gdprAnonymizedAt: { not: null } } }, { subscriptions: { some: { status: { in: ['CANCELLED', 'FINISHED'] } } } }] }, orderBy: { id: 'asc' }, take: limit, select: { id: true } });
  if (pending.length === 0) return { deleted: 0, failed: 0 };
  const before = new Set(pending.map((card) => card.id));
  const outcome = await deleteCardsOf(db, deps, { id: { in: [...before] } }, now);
  const done = await db.paymentMethodToken.findMany({ where: { id: { in: [...before] }, providerDeletedAt: { not: null } }, select: { id: true } });
  for (const card of done) await resolveAlert(db, `card-delete:${card.id}`, now);
  return { deleted: outcome.deleted, failed: outcome.pending };
}

/** Ficheros con el plazo de conservación vencido (`retainUntil`): se borran del almacén y se marcan. Si el almacén falla, se reintenta. */
export async function purgeExpiredFiles(db: Db, storage: () => StorageProvider, now: Date, limit: number): Promise<{ deleted: number; failed: number }> {
  const files = await db.fileAsset.findMany({ where: { retainUntil: { lt: now }, deletedAt: null }, take: limit, select: { id: true, bucket: true, objectKey: true } });
  const result = { deleted: 0, failed: 0 };
  if (files.length === 0) return result;
  // Solo se pide el almacén si hay algo que borrar: sin ficheros vencidos, la purga no exige tenerlo configurado.
  const provider = storage();
  for (const file of files) {
    try {
      await provider.remove(file.bucket, file.objectKey);
    } catch {
      result.failed += 1;
      continue;
    }
    await db.fileAsset.update({ where: { id: file.id }, data: { deletedAt: now } });
    result.deleted += 1;
  }
  return result;
}

const OVERDUE_SCAN_LIMIT = 1000;

/** Solicitudes RGPD sin responder en su plazo legal: alerta crítica por solicitud, que se cierra sola cuando se responde. */
export async function alertOverduePrivacyRequests(db: Db, now: Date): Promise<number> {
  const overdue = await overduePrivacyRequests(db, now, OVERDUE_SCAN_LIMIT);
  const keys = overdue.map((request) => `privacy-request:${request.id}`);
  for (const [index, request] of overdue.entries()) {
    await raiseAlert(db, { type: 'PRIVACY_REQUEST_OVERDUE', severity: 'CRITICAL', dedupeKey: keys[index]!, targetType: 'PrivacyRequest', targetId: String(request.id), detail: { privacyRequestId: request.id, type: request.type, dueAt: request.dueAt.toISOString() } }, now);
  }
  // Con la lista completa se pueden cerrar las que ya no están vencidas; recortada, cerraría alertas vigentes.
  if (overdue.length < OVERDUE_SCAN_LIMIT) await resolveAlertsNotIn(db, 'PRIVACY_REQUEST_OVERDUE', keys, now);
  return overdue.length;
}
