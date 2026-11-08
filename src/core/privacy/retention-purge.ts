import type { Db } from '@/lib/db';
import { anonymizedMarker } from './erasure.service';
import { daysBefore, fiscalCutoff, lastExpiredFiscalYear, RETENTION } from './retention-policy';

/**
 * Pasos de `DATA_RETENTION_PURGE` que solo tocan la base (QA-PRIV02). Cada uno trata como mucho `limit` filas y devuelve cuántas trató:
 * si llega al límite, la tarea vuelve a pasar. Solo anonimiza o borra lo que **ha superado su plazo**; nunca un asiento, una aportación
 * (sus importes), una factura, una firma de liquidación ni la auditoría (6 años, inmutable por trigger: solo admite vaciar IP y navegador).
 */

const ANONYMIZED_PREFIX = 'anonimizado:';
/** Marcas definitivas, sin relación con nadie. La de la supresión (`anonimizado:hmac:…`) aún impide firmar dos veces; esta ya no hace falta. */
const FINAL_SIGNATURE_PREFIX = 'anonimizado:firma:';
const FINAL_IDEA_PREFIX = 'anonimizado:idea:';

/** Datos fiscales y emails de aportaciones de ejercicios vencidos (6 años). Los importes y su asiento se conservan. */
export async function purgeExpiredDonorData(db: Db, now: Date, limit: number): Promise<number> {
  const rows = await db.contribution.findMany({
    where: {
      fiscalYear: { lte: lastExpiredFiscalYear(now) },
      OR: [{ donorTaxIdEnc: { not: null } }, { donorTaxIdHmac: { not: null } }, { donorFullName: { not: null } }, { donorProvinceCode: { not: null } }, { guestEmail: { not: null } }, { canonicalEmail: { not: null } }]
    },
    take: limit,
    select: { id: true }
  });
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.id);
  await db.ticketPass.updateMany({ where: { contributionId: { in: ids }, NOT: { holderEmail: { startsWith: ANONYMIZED_PREFIX } } }, data: { holderEmail: `${ANONYMIZED_PREFIX}caducado` } });
  const { count } = await db.contribution.updateMany({
    where: { id: { in: ids } },
    data: { donorTaxIdEnc: null, donorTaxIdHmac: null, donorTaxIdKeyVersion: null, donorFullName: null, donorProvinceCode: null, guestEmail: null, canonicalEmail: null }
  });
  return count;
}

/** Firmas de ideas cerradas hace más de un año: dejan de apuntar a una persona, un dispositivo o una red. El recuento de votos no cambia. */
export async function anonymizeOldIdeaSignatures(db: Db, now: Date, limit: number): Promise<number> {
  const cutoff = daysBefore(now, RETENTION.ideaSignatureDaysAfterIdea);
  const rows = await db.ideaSignatureAudit.findMany({
    where: { idea: { expiresAt: { lt: cutoff } }, OR: [{ userId: { not: null } }, { deviceId: { not: null } }, { ipSubnetHash: { not: null } }, { NOT: { canonicalEmail: { startsWith: FINAL_SIGNATURE_PREFIX } } }] },
    take: limit,
    select: { id: true }
  });
  for (const row of rows) await db.ideaSignatureAudit.update({ where: { id: row.id }, data: { canonicalEmail: anonymizedMarker('firma', row.id), userId: null, deviceId: null, ipSubnetHash: null } });
  const ideas = await db.idea.findMany({ where: { expiresAt: { lt: cutoff }, NOT: { authorCanonicalEmail: { startsWith: FINAL_IDEA_PREFIX } } }, take: limit, select: { id: true } });
  for (const idea of ideas) await db.idea.update({ where: { id: idea.id }, data: { authorCanonicalEmail: anonymizedMarker('idea', idea.id) } });
  return rows.length + ideas.length;
}

/** Mensajes de la familia en el chat de ideas cerradas hace más de un año: texto libre que ya no hace falta. Las respuestas del centro se conservan. */
export async function purgeOldIdeaChats(db: Db, now: Date, limit: number): Promise<number> {
  const rows = await db.ideaMessage.findMany({ where: { senderRole: 'FAMILY', idea: { expiresAt: { lt: daysBefore(now, RETENTION.ideaChatDaysAfterIdea) } } }, take: limit, select: { id: true } });
  if (rows.length === 0) return 0;
  const { count } = await db.ideaMessage.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  return count;
}

/**
 * Consultas de soporte resueltas hace más de dos años, o abiertas hace más de dos años sin resolverse nunca: dejan de tener email y texto. Queda la
 * fila (código, tema y fechas) para las estadísticas.
 */
export async function purgeResolvedSupportTickets(db: Db, now: Date, limit: number): Promise<number> {
  const rows = await db.supportTicket.findMany({
    where: {
      AND: [
        { OR: [{ status: 'RESOLVED', updatedAt: { lt: daysBefore(now, RETENTION.supportTicketDaysAfterResolved) } }, { status: { not: 'RESOLVED' }, createdAt: { lt: daysBefore(now, RETENTION.supportTicketDaysAfterResolved) } }] },
        { OR: [{ senderEmail: { not: null } }, { NOT: { message: '' } }, { replyMessage: { not: null } }] }
      ]
    },
    take: limit,
    select: { id: true }
  });
  if (rows.length === 0) return 0;
  const { count } = await db.supportTicket.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { senderEmail: null, message: '', subject: '', replyMessage: null } });
  return count;
}

/** Dispositivos sin uso en 13 meses (lo que dura su cookie): se borran con sus cuentas, porque la cookie ya no existe en ningún navegador. */
export async function purgeStaleDevices(db: Db, now: Date, limit: number): Promise<number> {
  const stale = await db.device.findMany({ where: { lastSeenAt: { lt: daysBefore(now, RETENTION.deviceDays) } }, take: limit, select: { id: true } });
  if (stale.length === 0) return 0;
  const { count } = await db.device.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  return count;
}

/** HMAC de IP y huella de más de 12 meses, en todas las tablas que los guardan (también la auditoría, que lo admite). */
export async function purgeNetworkHashes(db: Db, now: Date, limit: number): Promise<number> {
  const cutoff = daysBefore(now, RETENTION.networkHashDays);
  const devices = await db.device.findMany({ where: { lastSeenAt: { lt: cutoff }, fingerprintHmac: { not: null } }, take: limit, select: { id: true } });
  const signatures = await db.ideaSignatureAudit.findMany({ where: { createdAt: { lt: cutoff }, ipSubnetHash: { not: null } }, take: limit, select: { id: true } });
  const cosigns = await db.doubleCheckSignature.findMany({ where: { signedAt: { lt: cutoff }, signerIpHash: { not: null } }, take: limit, select: { id: true } });
  const audits = await db.auditLog.findMany({ where: { occurredAt: { lt: cutoff }, OR: [{ ipHash: { not: null } }, { userAgent: { not: null } }] }, take: limit, select: { id: true } });
  const results = await Promise.all([
    devices.length ? db.device.updateMany({ where: { id: { in: devices.map((row) => row.id) } }, data: { fingerprintHmac: null } }) : { count: 0 },
    signatures.length ? db.ideaSignatureAudit.updateMany({ where: { id: { in: signatures.map((row) => row.id) } }, data: { ipSubnetHash: null } }) : { count: 0 },
    cosigns.length ? db.doubleCheckSignature.updateMany({ where: { id: { in: cosigns.map((row) => row.id) } }, data: { signerIpHash: null } }) : { count: 0 },
    // El trigger de la auditoría solo deja vaciar los dos campos a la vez y nada más.
    audits.length ? db.auditLog.updateMany({ where: { id: { in: audits.map((row) => row.id) } }, data: { ipHash: null, userAgent: null } }) : { count: 0 }
  ]);
  return results.reduce((total, result) => total + result.count, 0);
}

/** Notificaciones de más de 12 meses: se vacía su contenido y su destinatario; queda constancia de que se enviaron. */
export async function purgeOldNotifications(db: Db, now: Date, limit: number): Promise<number> {
  const rows = await db.outboxMessage.findMany({
    where: { status: { in: ['SENT', 'FAILED', 'CANCELLED'] }, createdAt: { lt: daysBefore(now, RETENTION.notificationDays) }, NOT: { toAddress: '' } },
    take: limit,
    select: { id: true }
  });
  if (rows.length === 0) return 0;
  const { count } = await db.outboxMessage.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { toAddress: '', payloadJson: {}, lastError: null } });
  return count;
}

/**
 * Consentimientos sustituidos por otro posterior hace más de 3 años, y todos los de cuentas suprimidas hace más de 3 años. El más reciente
 * de cada persona y finalidad sigue vigente y no se borra, así que se recorre con cursor (`afterId`): si no, esos ocuparían siempre el lote.
 */
export async function purgeSupersededConsents(db: Db, now: Date, limit: number, afterId = 0): Promise<{ deleted: number; scanned: number; lastId: number }> {
  const cutoff = daysBefore(now, RETENTION.consentDaysAfterSuperseded);
  const candidates = await db.consentRecord.findMany({ where: { createdAt: { lt: cutoff }, id: { gt: afterId } }, orderBy: { id: 'asc' }, take: limit, select: { id: true, userId: true, deviceId: true, subjectEmailHmac: true, purpose: true } });
  const deletable = new Set<number>();
  const newestBySubject = new Map<string, number | null>();
  for (const row of candidates) {
    const subject = row.userId ? { userId: row.userId } : row.deviceId ? { deviceId: row.deviceId, userId: null } : row.subjectEmailHmac ? { subjectEmailHmac: row.subjectEmailHmac, userId: null, deviceId: null } : null;
    // Sin titular (dispositivo ya borrado, sin email): no hay nadie a quien siga obligando.
    if (!subject) {
      deletable.add(row.id);
      continue;
    }
    const key = `${JSON.stringify(subject)}:${row.purpose}`;
    if (!newestBySubject.has(key)) {
      const newest = await db.consentRecord.findFirst({ where: { ...subject, purpose: row.purpose, createdAt: { lt: cutoff } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
      newestBySubject.set(key, newest?.id ?? null);
    }
    if (newestBySubject.get(key) !== row.id) deletable.add(row.id);
  }
  const erasedOwners = await db.consentRecord.findMany({ where: { user: { gdprAnonymizedAt: { lt: cutoff } } }, take: limit, select: { id: true } });
  for (const row of erasedOwners) deletable.add(row.id);
  const lastId = candidates.at(-1)?.id ?? afterId;
  if (deletable.size === 0) return { deleted: 0, scanned: candidates.length, lastId };
  const { count } = await db.consentRecord.deleteMany({ where: { id: { in: [...deletable] } } });
  return { deleted: count, scanned: candidates.length, lastId };
}

/** Webhooks de pago de ejercicios vencidos (6 años). Los rechazados por firma ya los purga `OPS_HOUSEKEEPING` a los 90 días. */
export async function purgeExpiredWebhooks(db: Db, now: Date, limit: number): Promise<number> {
  const rows = await db.webhookEvent.findMany({ where: { receivedAt: { lt: fiscalCutoff(now, RETENTION.paymentWebhookYears) } }, take: limit, select: { id: true } });
  if (rows.length === 0) return 0;
  const { count } = await db.webhookEvent.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  return count;
}

/** Sesiones caducadas (con su IP y navegador, que guarda la capa de acceso) y códigos o enlaces de acceso caducados. */
export async function purgeExpiredSessions(db: Db, now: Date, limit: number): Promise<number> {
  const sessions = await db.session.findMany({ where: { expiresAt: { lt: now } }, take: limit, select: { id: true } });
  const verifications = await db.verification.findMany({ where: { expiresAt: { lt: now } }, take: limit, select: { id: true } });
  const [a, b] = await Promise.all([
    sessions.length ? db.session.deleteMany({ where: { id: { in: sessions.map((row) => row.id) } } }) : { count: 0 },
    verifications.length ? db.verification.deleteMany({ where: { id: { in: verifications.map((row) => row.id) } } }) : { count: 0 }
  ]);
  return a.count + b.count;
}
