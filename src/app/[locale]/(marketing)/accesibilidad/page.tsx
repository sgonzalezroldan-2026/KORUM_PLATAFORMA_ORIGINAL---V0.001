import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/seo/json-ld';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { breadcrumbJsonLd } from '@/lib/seo/json-ld';
import { ACCESSIBILITY_PATH } from '@/lib/seo/marketing-routes';
import { buildPageMetadata } from '@/lib/seo/metadata';
import { getPublicPlatformConfig } from '@/services/marketing/public-config';

/** Fecha de la declaración y de su última revisión (AAAA-MM-DD): se cambia al revisarla. */
const STATEMENT_DATE = '2026-11-14';

// El buzón de contacto sale de la consola: la página se vuelve a generar cada 10 minutos.
export const revalidate = 600;

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const [t, marketing] = await Promise.all([getTranslations({ locale, namespace: 'marketing.accessibility' }), getTranslations({ locale, namespace: 'marketing' })]);
  return buildPageMetadata({
    locale,
    path: ACCESSIBILITY_PATH,
    title: t('metaTitle'),
    description: t('metaDescription'),
    imageAlt: marketing('ogAlt')
  });
}

/**
 * Declaración de accesibilidad (Sprint 5.5b, EXPERIENCIA §7, Regla 03 §8): el nivel que buscamos (WCAG 2.2 AA), cómo lo comprobamos, lo que sabemos que aún falla
 * y el canal para comunicar un problema. **El texto legal (plazo de respuesta, vía de reclamación y norma aplicable) lo revisa el abogado** (CUMPLIMIENTO §9).
 */
export default async function AccessibilityPage({ params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const [t, marketing, nav, { contactEmail }] = await Promise.all([getTranslations('marketing.accessibility'), getTranslations('marketing'), getTranslations('nav'), getPublicPlatformConfig()]);
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeZone: 'Europe/Madrid'
  }).format(new Date(`${STATEMENT_DATE}T12:00:00Z`));
  const list = (key: string) => t.raw(key) as string[];
  const section = 'flex flex-col gap-3';
  const heading = 'font-corp text-2xl font-extrabold text-varsity-navy';

  return (
    <div className="korum-paper-dots">
      <JsonLd
        data={[
          breadcrumbJsonLd(locale, [
            { name: marketing('breadcrumbHome'), path: '/' },
            { name: nav('pages.accesibilidad'), path: ACCESSIBILITY_PATH }
          ])
        ]}
      />
      <article className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:py-14">
        <header>
          <nav aria-label={marketing('breadcrumbLabel')} className="text-sm text-ink-soft">
            <ol className="flex flex-wrap items-center gap-2">
              <li>
                <Link href="/" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg underline underline-offset-4">
                  {marketing('breadcrumbHome')}
                </Link>
              </li>
              <li aria-hidden="true">{'›'}</li>
              <li aria-current="page">{nav('pages.accesibilidad')}</li>
            </ol>
          </nav>
          <h1 className="font-joy mt-2 text-3xl font-bold leading-tight text-varsity-navy sm:text-4xl">{t('h1')}</h1>
          <p className="mt-4 text-lg text-ink">{t('intro')}</p>
          <p className="mt-2 text-sm text-ink-soft">
            {t('dateLabel')} <time dateTime={STATEMENT_DATE}>{date}</time>
          </p>
        </header>

        <section aria-labelledby="a11y-status" className={section}>
          <h2 id="a11y-status" className={heading}>
            {t('statusTitle')}
          </h2>
          <p>{t('statusText')}</p>
        </section>

        <section aria-labelledby="a11y-checks" className={section}>
          <h2 id="a11y-checks" className={heading}>
            {t('checksTitle')}
          </h2>
          <ul className="flex list-disc flex-col gap-2 ps-6">
            {list('checks').map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="a11y-limits" className={section}>
          <h2 id="a11y-limits" className={heading}>
            {t('limitsTitle')}
          </h2>
          <ul className="flex list-disc flex-col gap-2 ps-6">
            {list('limits').map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="a11y-contact" className="korum-trust-vault flex flex-col gap-3 p-5">
          <h2 id="a11y-contact" className={heading}>
            {t('contactTitle')}
          </h2>
          {contactEmail ? (
            <>
              <p>{t('contactText')}</p>
              <p>
                <a
                  href={`mailto:${contactEmail}?subject=${encodeURIComponent(t('mailSubject'))}`}
                  className="inline-flex min-h-11 items-center font-bold text-varsity-navy underline underline-offset-4 wrap-anywhere"
                  data-testid="a11y-contact-email"
                >
                  {contactEmail}
                </a>
              </p>
              <p className="text-sm text-ink-soft">{t('contactInclude')}</p>
              <p className="text-sm text-ink-soft">{t('responseTime')}</p>
            </>
          ) : (
            // Sin buzón en la consola no se promete un canal que no existe (auditoría del 5.5b, H4); el buzón es requisito del paso a producción (ficha 6.1).
            <p data-testid="a11y-contact-fallback">{t('contactFallback')}</p>
          )}
        </section>

        {contactEmail ? (
          // La reclamación habla de «responder a tiempo»: solo tiene sentido con un buzón y su plazo a la vista (segunda pasada de seguridad del 5.5b).
          <section aria-labelledby="a11y-enforcement" className={section}>
            <h2 id="a11y-enforcement" className={heading}>
              {t('enforcementTitle')}
            </h2>
            <p>{t('enforcementText')}</p>
          </section>
        ) : null}
      </article>
    </div>
  );
}
