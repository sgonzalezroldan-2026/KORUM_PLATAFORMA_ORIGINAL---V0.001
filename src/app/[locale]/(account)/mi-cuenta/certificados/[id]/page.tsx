import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { DonationDocumentView } from '@/components/account/donation-document-view';
import { RevealTaxId } from '@/components/account/reveal-tax-id';
import { getKeyring } from '@/config/keyring';
import { DecryptionError } from '@/core/security/crypto';
import { accountReauthIsFresh } from '@/core/security/verified-actor';
import { buildDonationDocument } from '@/core/tax/donation-document';
import { openDonorTaxId } from '@/core/tax/tax-id-vault';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { requireSession } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { INITIATIVE_ID_PATTERN } from '@/lib/seo/portal-routes';
import { AccountNotFoundError, findOwnDonationDocument } from '@/repositories/account.repository';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ locale: string; id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'account.documents' });
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/** NIF oculto salvo las 4 últimas cifras. */
const maskTaxId = (taxId: string) => `${'•'.repeat(Math.max(0, taxId.length - 4))}${taxId.slice(-4)}`;

/**
 * Hoja de una donación: certificado fiscal o justificante nominativo. Solo la ve quien donó (cuenta de la sesión, o su email verificado): la
 * donación de otra persona responde el mismo 404 que una que no existe. El NIF se descifra aquí, en servidor, solo para el certificado, y sale
 * **oculto** (solo las 4 últimas cifras) salvo que esta sesión haya confirmado la identidad en los últimos 10 minutos.
 */
export default async function DonationDocumentPage({ params }: Params) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale) || !INITIATIVE_ID_PATTERN.test(id)) notFound();
  setRequestLocale(locale);
  const session = await requireSession(locale, localizedPath(locale, `/mi-cuenta/certificados/${id}`));
  const t = await getTranslations({ locale, namespace: 'account.documents' });

  let row;
  try {
    row = await findOwnDonationDocument(getPrisma(), session.userId, Number(id));
  } catch (error) {
    if (error instanceof AccountNotFoundError) notFound();
    throw error;
  }
  if (!row) notFound();

  const document = buildDonationDocument(row.organization, row);
  const revealed = await accountReauthIsFresh(getPrisma(), { userId: session.userId, sessionId: session.sessionId });
  let donorTaxId: string | null = null;
  if (document.kind === 'TAX_CERTIFICATE' && row.donorTaxIdEnc) {
    try {
      const taxId = openDonorTaxId(getKeyring(), row.donorTaxIdEnc, row.donorTaxIdKeyVersion);
      donorTaxId = revealed ? taxId : maskTaxId(taxId);
    } catch (error) {
      // Sin la clave que lo cifró, el documento se enseña sin NIF (la consola ya avisa de las claves que faltan).
      if (!(error instanceof DecryptionError)) throw error;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/mi-cuenta/certificados" className="inline-flex min-h-11 items-center gap-1 self-start font-semibold text-varsity-navy underline underline-offset-4 print:hidden">
        <span aria-hidden="true">{'← '}</span>
        {t('backToList')}
      </Link>
      {document.kind === 'TAX_CERTIFICATE' && donorTaxId && !revealed ? <RevealTaxId email={session.email} /> : null}
      <DonationDocumentView
        locale={locale}
        document={{
          ...document,
          donorTaxId,
          donorProvinceCode: row.donorProvinceCode,
          initiativeTitle: row.initiative.title
        }}
      />
    </div>
  );
}
