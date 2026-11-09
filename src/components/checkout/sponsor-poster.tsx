import { getFormatter, getTranslations } from 'next-intl/server';
import QRCode from 'qrcode';
import type { Locale } from '@/i18n/routing';
import type { SponsorshipDocuments } from '@/repositories/sponsorship.repository';
import { publicLogoSrc } from '@/services/portal/achievements-data';

/**
 * Cartel de escaparate de un comercio amigo (Sprint 4.2b, `sponsor.welcome`), para imprimir en una hoja: la categoría, el nombre de la entidad a la que
 * apoya, la ventaja para las familias y un QR a su página de comercios amigos. Sin importes. Solo existe mientras el comercio está aprobado y vigente:
 * un cartel de un comercio devuelto o caducado no debe seguir colgado.
 */

const BADGE: Record<string, { icon: string; className: string }> = {
  ORO: {
    icon: '🥇',
    className: 'bg-amber-400 text-slate-950 border-amber-600'
  },
  PLATA: {
    icon: '🥈',
    className: 'bg-slate-200 text-slate-900 border-slate-500'
  },
  BRONCE: {
    icon: '🥉',
    className: 'bg-orange-100 text-amber-950 border-orange-500'
  }
};

export async function SponsorPoster({ locale, documents, directoryUrl }: { locale: Locale; documents: SponsorshipDocuments; directoryUrl: string }) {
  const t = await getTranslations({
    locale,
    namespace: 'portal.sponsorDocs.cartel'
  });
  const tLevel = await getTranslations({
    locale,
    namespace: 'portal.sponsorDocs.level'
  });
  const format = await getFormatter({ locale });
  const { sponsor } = documents;
  if (!sponsor || sponsor.status !== 'APPROVED' || sponsor.expiresAt <= new Date()) {
    return (
      <p role="status" className="rounded-xl bg-patio-cream p-4 text-ink">
        {t('unavailable')}
      </p>
    );
  }
  const badge = BADGE[sponsor.categoryLevel] ?? BADGE.PLATA!;
  const logo = publicLogoSrc(sponsor.logoFile);
  const contentLang = documents.organization.contentLocale === locale ? undefined : documents.organization.contentLocale;
  const qrSvg = await QRCode.toString(directoryUrl, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2
  });

  return (
    <section
      aria-label={t('label')}
      className="flex flex-col items-center gap-4 rounded-3xl border-4 border-varsity-navy bg-white p-6 text-center print:break-inside-avoid"
      data-testid="sponsor-poster"
    >
      <p className={`inline-flex rounded-full border-2 px-4 py-1.5 font-corp text-lg font-extrabold ${badge.className}`}>
        <span aria-hidden="true">{`${badge.icon} `}</span>
        {tLevel(sponsor.categoryLevel)}
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element -- imagen pública servida por /api/files/public, sin optimizador en la impresión */}
      {logo ? <img src={logo} alt="" className="max-h-28 w-auto object-contain" /> : null}
      {/* Lo que escribe el comercio va en el idioma del contenido de la entidad (WCAG 3.1.2). */}
      <p lang={contentLang} className="font-joy text-3xl font-bold text-varsity-navy wrap-anywhere">
        {sponsor.name}
      </p>
      <p className="font-corp text-xl font-extrabold text-varsity-emerald">{t('friendOf', { entity: documents.organization.name })}</p>
      {sponsor.promo ? (
        <p lang={contentLang} className="rounded-2xl bg-amber-50 px-4 py-3 text-lg font-bold text-amber-950 wrap-anywhere">
          {sponsor.code ? t('promoWithCode', { promo: sponsor.promo, code: sponsor.code }) : sponsor.promo}
        </p>
      ) : null}
      <div aria-hidden="true" className="size-40 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: qrSvg }} />
      <p className="text-sm text-ink-soft">{t('scan', { entity: documents.organization.name })}</p>
      {/* Alternativa al QR, impresa: quien no puede escanear lo teclea. */}
      <p className="break-all font-corp text-base font-extrabold text-varsity-navy" data-testid="poster-url">
        {directoryUrl.replace(/^https?:\/\//, '')}
      </p>
      <p className="text-xs text-ink-soft">
        {t('validUntil', {
          date: format.dateTime(sponsor.expiresAt, {
            dateStyle: 'long',
            timeZone: 'Europe/Madrid'
          })
        })}
      </p>
    </section>
  );
}
