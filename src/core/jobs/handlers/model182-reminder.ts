import { dataHmac } from '@/core/security/data-hmac';
import type { Prisma } from '@/generated/prisma/client';
import type { Db } from '@/lib/db';
import type { JobHandler } from '../job-types';
import { notifySigners } from '../notify';

/**
 * `MODEL182_REMINDER` (2 de enero): recuerda a quienes firman, en cada entidad con la Ley 49/2002 verificada que cobró donaciones el
 * ejercicio anterior, que ya pueden exportar el Modelo 182. Las entradas no cuentan (Regla 02 §8); solo las donaciones completadas y sin
 * devolver. Un aviso por entidad y ejercicio, aunque la tarea se repita.
 *
 * Además (Sprint 3.7), avisa a cada **donante con certificado fiscal** de ese ejercicio (`tax.certificateReady`, con el enlace a
 * `/mi-cuenta/certificados`): un único email por persona y ejercicio aunque haya donado a varias entidades o la tarea se repita. La persona se
 * identifica por su email canónico, que en la clave del aviso va solo como HMAC.
 */

/** Lo mismo que da certificado (`donationDocumentKind`): Ley 49/2002 verificada, NIF y nombre del donante, completada y sin devolución. */
const CERTIFIED_DONATION = {
  type: 'DONATION',
  status: 'COMPLETED',
  refundedCents: 0,
  donorTaxIdHmac: { not: null },
  donorFullName: { not: null },
  canonicalEmail: { not: null },
  organization: { ley49: true, ley49VerifiedAt: { not: null } }
} as const satisfies Prisma.ContributionWhereInput;

async function notifyCertificateDonors(db: Db, hmacSecret: string, fiscalYear: number, batchSize: number): Promise<number> {
  let cursor: number | undefined;
  let notified = 0;
  for (;;) {
    const rows = await db.contribution.findMany({
      where: { ...CERTIFIED_DONATION, fiscalYear },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor === undefined ? {} : { skip: 1, cursor: { id: cursor } }),
      select: { id: true, canonicalEmail: true, guestEmail: true, locale: true, user: { select: { id: true, email: true, locale: true, gdprAnonymizedAt: true } } }
    });
    const messages = rows.flatMap((row) => {
      // Una cuenta suprimida no recibe nada; una compra como invitada va a su email de invitada.
      const account = row.user && !row.user.gdprAnonymizedAt ? row.user : null;
      const toAddress = account?.email ?? (row.user ? null : row.guestEmail);
      if (!toAddress || !row.canonicalEmail) return [];
      return [
        {
          idempotencyKey: `tax.certificateReady:${fiscalYear}:${dataHmac(hmacSecret, 'tax-certificate-notice', row.canonicalEmail)}`,
          templateKey: 'tax.certificateReady',
          locale: account?.locale ?? row.locale,
          toAddress,
          userId: account?.id ?? null,
          payloadJson: { fiscalYear }
        }
      ];
    });
    if (messages.length > 0) notified += (await db.outboxMessage.createMany({ data: messages, skipDuplicates: true })).count;
    const last = rows.at(-1);
    if (!last || rows.length < batchSize) break;
    cursor = last.id;
  }
  return notified;
}

export const model182ReminderHandler: JobHandler = async ({ db, now, batchSize, deps }) => {
  const fiscalYear = now.getUTCFullYear() - 1;
  let cursor: string | undefined;
  let processed = 0;
  let notified = 0;
  for (;;) {
    const organizations = await db.organization.findMany({
      where: { ley49: true, ley49VerifiedAt: { not: null }, archivedAt: null, contributions: { some: { type: 'DONATION', status: 'COMPLETED', fiscalYear } } },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true }
    });
    for (const { id } of organizations) notified += await notifySigners(db, id, 'model182.reminder', `${id}:${fiscalYear}`, { fiscalYear });
    processed += organizations.length;
    const last = organizations.at(-1);
    if (!last || organizations.length < batchSize) break;
    cursor = last.id;
  }
  const donorsNotified = await notifyCertificateDonors(db, deps.hmacSecret(), fiscalYear, batchSize);
  return { processed, hasMore: false, detail: { fiscalYear, notified, donorsNotified } };
};
