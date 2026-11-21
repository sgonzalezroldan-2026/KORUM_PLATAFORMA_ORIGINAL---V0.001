import { LEGAL_BASE_LOCALE, LEGAL_LOCALES, type LegalDocument, type LegalLocale } from '@/core/legal/legal-catalog';
import { SIGNER_ROLES } from '@/core/security/double-check-evaluation';
import type { Db } from '@/lib/db';

/**
 * Aviso a quienes firman por cada entidad en marcha de que cambia un texto que aceptaron (`legal.changeNotice`, decisión 54; Sprint 5.10a). Lo recibe quien lee
 * ese texto en este idioma: con una versión nueva en castellano, todas las cuentas (las traducciones que hubiera son ya anteriores, así que se lee el castellano,
 * decisión 85); con una traducción, quien tiene la cuenta en ese idioma.
 */
export interface EntityNotice {
  document: LegalDocument;
  locale: LegalLocale;
  version: string;
  effectiveAt: Date;
  changeSummary: string | null;
  urgent: boolean;
}

export async function queueEntityNotices(tx: Db, notice: EntityNotice): Promise<number> {
  const locales: LegalLocale[] = notice.locale === LEGAL_BASE_LOCALE ? [...LEGAL_LOCALES] : [notice.locale];
  const signers = await tx.organizationMember.findMany({
    where: { role: { in: [...SIGNER_ROLES] }, organization: { archivedAt: null }, user: { gdprAnonymizedAt: null, isSuperadmin: false, locale: { in: locales } } },
    select: { organizationId: true, userId: true, user: { select: { email: true, locale: true } } }
  });
  if (signers.length === 0) return 0;
  const { count } = await tx.outboxMessage.createMany({
    data: signers.map((signer) => ({
      idempotencyKey: `legal.changeNotice:${notice.document}:${notice.locale}:${notice.version}:${signer.organizationId}:${signer.userId}`,
      templateKey: 'legal.changeNotice',
      locale: signer.user.locale,
      toAddress: signer.user.email,
      userId: signer.userId,
      organizationId: signer.organizationId,
      payloadJson: {
        document: notice.document,
        version: notice.version,
        effectiveAt: notice.effectiveAt.toISOString(),
        ...(notice.changeSummary ? { changeSummary: notice.changeSummary } : {}),
        ...(notice.urgent ? { urgent: true } : {})
      }
    })),
    skipDuplicates: true
  });
  return count;
}
