import { getFormatter, getTranslations } from 'next-intl/server';
import { LEGAL_BASE_LOCALE, legalPathOf, PRIVACY_CHANGE_NOTICE_DAYS } from '@/core/legal/legal-catalog';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';

/**
 * Franja fija de un cambio importante de la política de privacidad (Sprint 5.10b, política §13; decisión 90): arriba de *Mi cuenta* y del panel de la entidad durante
 * 30 días desde que se publica una versión con cambio importante en este idioma o en castellano (que es la que se lee sin traducción al día), aunque después se
 * publique otra versión sin la casilla (una errata), con «qué cambia» y el enlace a la política. Sin cambio importante reciente no pinta nada.
 * Componente de servidor: no guarda nada en el navegador (sin cookies ni almacenamiento).
 */
export async function PrivacyChangeBanner({ locale, now = new Date() }: { locale: Locale; now?: Date }) {
  const policy = await getPrisma().legalDocumentVersion.findFirst({
    where: { document: 'privacidad', importantChange: true, locale: { in: [...new Set([locale, LEGAL_BASE_LOCALE])] }, publishedAt: { gte: new Date(now.getTime() - PRIVACY_CHANGE_NOTICE_DAYS * 86_400_000), lte: now } },
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    select: { locale: true, publishedAt: true, changeSummary: true }
  });
  if (!policy) return null;
  const [t, format] = await Promise.all([getTranslations({ locale, namespace: 'legal.privacyNotice' }), getFormatter({ locale })]);
  const date = format.dateTime(policy.publishedAt, { dateStyle: 'long', timeZone: 'Europe/Madrid' });
  return (
    <aside aria-labelledby="privacy-change-title" className="border-b-2 border-amber-600/40 bg-amber-50 px-4 py-3 text-amber-950" data-testid="privacy-change-banner">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-1">
        <p id="privacy-change-title" className="font-corp font-extrabold">
          {t('title')}
        </p>
        <p>{t('text', { date })}</p>
        {policy.changeSummary ? (
          <p className="wrap-break-word">
            {t('summaryLabel')} <span lang={policy.locale === locale ? undefined : policy.locale}>{policy.changeSummary}</span>
          </p>
        ) : null}
        <Link href={legalPathOf('privacidad')} className="inline-flex min-h-11 items-center self-start font-semibold text-amber-950 underline underline-offset-4">
          {t('read')}
        </Link>
      </div>
    </aside>
  );
}
