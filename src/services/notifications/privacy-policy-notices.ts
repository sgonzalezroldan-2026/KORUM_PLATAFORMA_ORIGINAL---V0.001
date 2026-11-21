import { LEGAL_BASE_LOCALE, LEGAL_LOCALES, type LegalLocale } from '@/core/legal/legal-catalog';
import { inTransaction, type Db } from '@/lib/db';

/**
 * Email de un cambio importante de la política de privacidad (`legal.privacyChange`, Sprint 5.10b; política §13, decisión 90). Al publicarse la versión con la casilla
 * marcada queda una fila `PrivacyPolicyNotice`; esta parte de la tarea `SUPPORTER_BROADCAST` la reparte por lotes, siguiendo desde la última cuenta tratada, a todas las
 * cuentas con el email verificado que leen esa versión: con una versión en castellano, todas (las traducciones que hubiera son ya anteriores y se lee el castellano,
 * decisión 85); con una traducción, quien tiene la cuenta en ese idioma. Una vez por cuenta y versión (`idempotencyKey`). El envío es de `OUTBOX_DISPATCH`.
 */

export interface PrivacyNoticeRun {
  now: Date;
  batchSize: number;
  deadline?: number;
}

async function advance(db: Db, noticeId: number, run: PrivacyNoticeRun): Promise<{ queued: number; done: boolean }> {
  return inTransaction(db, async (tx) => {
    const notice = await tx.privacyPolicyNotice.findUnique({ where: { id: noticeId } });
    if (!notice || notice.completedAt) return { queued: 0, done: true };
    const version = await tx.legalDocumentVersion.findUnique({ where: { document_locale_version: { document: 'privacidad', locale: notice.locale, version: notice.version } }, select: { changeSummary: true } });
    const locales: LegalLocale[] = notice.locale === LEGAL_BASE_LOCALE ? [...LEGAL_LOCALES] : [notice.locale];
    const users = await tx.user.findMany({
      where: { id: { gt: notice.cursorUserId }, emailVerified: true, gdprAnonymizedAt: null, locale: { in: locales } },
      orderBy: { id: 'asc' },
      take: run.batchSize,
      select: { id: true, email: true, locale: true }
    });
    const { count } =
      users.length > 0
        ? await tx.outboxMessage.createMany({
            data: users.map((user) => ({
              idempotencyKey: `legal.privacyChange:${notice.locale}:${notice.version}:${user.id}`,
              templateKey: 'legal.privacyChange',
              locale: user.locale,
              toAddress: user.email,
              userId: user.id,
              payloadJson: { version: notice.version, ...(version?.changeSummary ? { changeSummary: version.changeSummary } : {}) }
            })),
            skipDuplicates: true
          })
        : { count: 0 };
    const done = users.length < run.batchSize;
    await tx.privacyPolicyNotice.update({
      where: { id: notice.id },
      data: { cursorUserId: users.at(-1)?.id ?? notice.cursorUserId, queuedCount: { increment: count }, ...(done ? { completedAt: run.now } : {}) }
    });
    return { queued: count, done };
  });
}

/** Parte de la tarea `SUPPORTER_BROADCAST`: los avisos pendientes, el más antiguo primero, hasta acabarlos o hasta el límite de tiempo de la ejecución. */
export async function runPrivacyPolicyNotices(db: Db, run: PrivacyNoticeRun): Promise<{ processed: number; queued: number; hasMore: boolean }> {
  const pending = await db.privacyPolicyNotice.findMany({ where: { completedAt: null }, orderBy: { id: 'asc' }, select: { id: true } });
  let processed = 0;
  let queued = 0;
  for (const { id } of pending) {
    for (;;) {
      if (run.deadline !== undefined && Date.now() > run.deadline) return { processed, queued, hasMore: true };
      const step = await advance(db, id, run);
      queued += step.queued;
      if (step.done) break;
    }
    processed += 1;
  }
  return { processed, queued, hasMore: false };
}
