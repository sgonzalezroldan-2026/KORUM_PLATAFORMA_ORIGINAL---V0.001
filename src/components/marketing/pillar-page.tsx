import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { JsonLd } from '@/components/seo/json-ld';
import { Link } from '@/i18n/navigation';
import { isLocale, type Locale } from '@/i18n/routing';
import { breadcrumbJsonLd, faqJsonLd, type JsonLdNode } from '@/lib/seo/json-ld';
import { MARKETING_CONTENT_UPDATED, pillarByKey, type PillarKey } from '@/lib/seo/marketing-routes';
import { buildPageMetadata } from '@/lib/seo/metadata';
import { fillTokensDeep, pricingTokens } from '@/lib/seo/pricing-tokens';
import { getPublicPlatformConfig } from '@/services/marketing/public-config';
import { CtaBand } from './cta-band';
import { PILLAR_ILLUSTRATIONS } from './illustrations';
import { collectFaq, parsePillarContent } from './pillar-content';
import { PricingTable } from './pricing-table';

export interface PillarProps {
  params: Promise<{ locale: string }>;
}

/** Los comercios y las familias buscan su entidad; el resto de públicos da de alta la suya. */
const CTA_ACTION: Record<PillarKey, 'signup' | 'finder'> = {
  colegios: 'signup',
  clubes: 'signup',
  culturales: 'signup',
  comercios: 'finder',
  comoFunciona: 'signup',
  precios: 'signup',
  seguridad: 'signup',
  faq: 'signup'
};

async function loadPillar(locale: Locale, key: PillarKey) {
  const t = await getTranslations({ locale, namespace: 'marketing.pages' });
  const { pricing } = await getPublicPlatformConfig();
  // `raw`: el texto lleva marcas {exempt}, {t1Rate}… que se sustituyen con las tarifas vigentes, no variables de ICU.
  const content = fillTokensDeep(parsePillarContent(t.raw(key)), pricingTokens(pricing, locale));
  return { content, pricing };
}

export async function pillarMetadata(key: PillarKey, { params }: PillarProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const [{ content }, t] = await Promise.all([loadPillar(locale, key), getTranslations({ locale, namespace: 'marketing' })]);
  return buildPageMetadata({ locale, path: pillarByKey(key).path, title: content.title, description: content.description, imageAlt: t('ogAlt'), ogPage: key });
}

/** Plantilla de las 8 páginas pilar: responde en el primer párrafo, desarrolla por secciones y cierra con una llamada a la acción. */
export async function PillarPage({ pageKey, params }: PillarProps & { pageKey: PillarKey }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const [{ content, pricing }, t, nav] = await Promise.all([loadPillar(locale, pageKey), getTranslations('marketing'), getTranslations('nav')]);
  const path = pillarByKey(pageKey).path;
  const updated = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(new Date(`${MARKETING_CONTENT_UPDATED}T12:00:00Z`));
  const Illustration = PILLAR_ILLUSTRATIONS[pageKey];
  const faq = collectFaq(content);
  const structuredData: JsonLdNode[] = [breadcrumbJsonLd(locale, [{ name: t('breadcrumbHome'), path: '/' }, { name: nav(`pages.${pageKey}`), path }]), ...(faq.length > 0 ? [faqJsonLd(faq)] : [])];

  return (
    <div className="korum-paper-dots">
      <JsonLd data={structuredData} />
      <article className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:py-14">
        <header>
          <nav aria-label={t('breadcrumbLabel')} className="text-sm text-ink-soft">
            <ol className="flex flex-wrap items-center gap-2">
              <li>
                <Link href="/" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg underline underline-offset-4">
                  {t('breadcrumbHome')}
                </Link>
              </li>
              <li aria-hidden="true">{'›'}</li>
              <li aria-current="page">{nav(`pages.${pageKey}`)}</li>
            </ol>
          </nav>
          <h1 className="font-joy mt-2 text-3xl font-bold leading-tight text-varsity-navy sm:text-4xl">{content.h1}</h1>
          <p className="mt-4 text-lg text-ink">{content.answer}</p>
          <p className="mt-2 text-sm text-ink-soft">
            {t('updated')} <time dateTime={MARKETING_CONTENT_UPDATED}>{updated}</time>
          </p>
        </header>

        {Illustration ? <Illustration className="mx-auto h-auto w-full max-w-md" /> : null}

        {pageKey === 'precios' ? <PricingTable pricing={pricing} locale={locale} /> : null}

        {content.sections.map((section, sectionIndex) => (
          <section key={section.title} aria-labelledby={`s-${sectionIndex}`} className="flex flex-col gap-3">
            <h2 id={`s-${sectionIndex}`} className="font-corp text-2xl font-extrabold text-varsity-navy">
              {section.title}
            </h2>
            {section.paragraphs?.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            {section.bullets ? (
              <ul className="flex list-disc flex-col gap-2 ps-6 marker:text-varsity-gold-deep">
                {section.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
            {section.steps ? (
              <ol className="flex flex-col gap-3">
                {section.steps.map((step, index) => (
                  <li key={step.title} className="korum-notebook-sheet">
                    <h3 className="font-corp text-lg font-bold text-varsity-navy">
                      <span className="die-cut-sticker me-2" aria-hidden="true">
                        {index + 1}
                      </span>
                      {step.title}
                    </h3>
                    <p className="mt-1">{step.text}</p>
                  </li>
                ))}
              </ol>
            ) : null}
            {section.faq ? (
              <div className="flex flex-col gap-2">
                {section.faq.map((item) => (
                  <details key={item.q} className="rounded-xl border-2 border-patio-rule-strong bg-white px-4 open:border-varsity-navy">
                    <summary className="flex min-h-11 cursor-pointer items-center py-2 font-bold text-varsity-navy">{item.q}</summary>
                    <p className="pb-4">{item.a}</p>
                  </details>
                ))}
              </div>
            ) : null}
          </section>
        ))}

        <CtaBand title={content.ctaTitle} text={content.ctaText} action={CTA_ACTION[pageKey]} />
      </article>
    </div>
  );
}
