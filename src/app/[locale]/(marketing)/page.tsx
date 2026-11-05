import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { KorumMark } from '@/components/brand/korum-mark';
import { EntityFinder } from '@/components/marketing/entity-finder';
import { ImpactCalculator } from '@/components/marketing/impact-calculator';
import { PatioIllustration } from '@/components/marketing/illustrations';
import { JsonLd } from '@/components/seo/json-ld';
import { TrustBadge } from '@/components/ui/trust-badge';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { organizationJsonLd, websiteJsonLd } from '@/lib/seo/json-ld';
import { buildPageMetadata } from '@/lib/seo/metadata';
import { getPublicPlatformConfig } from '@/services/marketing/public-config';

type PageProps = { params: Promise<{ locale: string }> };

// Las tarifas del simulador salen de la consola: la portada se vuelve a generar cada 10 minutos.
export const revalidate = 600;

/** Cada tarjeta de público (entidades, familias, comercios; en ese orden en los catálogos) lleva a su página pilar. */
const AUDIENCE_LINKS = ['/para-colegios', '/como-funciona', '/para-comercios'] as const;
interface AudienceCard {
  title: string;
  bullets: string[];
  link: string;
}
interface Step {
  title: string;
  text: string;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const [meta, marketing] = await Promise.all([getTranslations({ locale, namespace: 'metadata' }), getTranslations({ locale, namespace: 'marketing' })]);
  return buildPageMetadata({ locale, path: '/', title: meta('title'), description: meta('description'), imageAlt: marketing('ogAlt'), ogPage: 'home', absoluteTitle: true });
}

/** Portada del Entorno 0: promesa, buscador de entidades, cómo funciona, simulador de impacto, públicos y cómo se trata el dinero. */
export default async function HomePage({ params }: PageProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const [t, meta, brand, config] = await Promise.all([getTranslations('home'), getTranslations('metadata'), getTranslations('brand'), getPublicPlatformConfig()]);
  const steps = t.raw('steps.items') as Step[];
  const audiences = t.raw('audiences.cards') as AudienceCard[];

  return (
    <div className="korum-paper-dots">
      <JsonLd data={[organizationJsonLd({ description: meta('description'), slogan: brand('tagline') }), websiteJsonLd(locale, { description: meta('description') })]} />

      <section className="mx-auto flex w-full max-w-4xl flex-col items-center gap-6 px-4 py-14 text-center sm:py-20">
        <KorumMark size={112} />
        <p className="font-corp text-sm font-bold uppercase tracking-[0.18em] text-varsity-emerald">{t('eyebrow')}</p>
        <h1 className="font-joy text-4xl font-bold leading-tight text-varsity-navy sm:text-5xl">{t('title')}</h1>
        <p className="max-w-2xl text-lg text-ink-soft">{t('subtitle')}</p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link href="/registro-comunidad" className="tactile-btn">
            {t('ctaSignup')}
          </Link>
          <Link href="/#buscador" className="inline-flex min-h-11 items-center rounded-lg border-2 border-varsity-navy px-4 font-bold text-varsity-navy hover:bg-varsity-navy/10">
            {t('ctaFind')}
          </Link>
          <Link href="/login" className="inline-flex min-h-11 items-center rounded-lg px-3 font-bold text-varsity-navy underline underline-offset-4">
            {t('ctaLogin')}
          </Link>
        </div>
        <ul className="mt-2 flex flex-wrap justify-center gap-3">
          <li>
            <TrustBadge icon="🛡️" tone="emerald">
              {t('badgeRefund')}
            </TrustBadge>
          </li>
          <li>
            <TrustBadge icon="🤝">{t('badgeProvider')}</TrustBadge>
          </li>
          <li>
            <TrustBadge icon="💳">{t('badgePayments')}</TrustBadge>
          </li>
        </ul>
        <PatioIllustration className="mt-6 h-auto w-full max-w-xl" />
      </section>

      <section id="buscador" aria-labelledby="finder-title" className="mx-auto w-full max-w-3xl scroll-mt-4 px-4 py-10">
        <h2 id="finder-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('finder.title')}
        </h2>
        <p className="mb-4 mt-1 text-ink-soft">{t('finder.intro')}</p>
        <EntityFinder />
      </section>

      <section aria-labelledby="steps-title" className="mx-auto w-full max-w-5xl px-4 py-10">
        <h2 id="steps-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('steps.title')}
        </h2>
        <ol className="mobile-stack mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((step, index) => (
            <li key={step.title} className="korum-notebook-sheet">
              <span className="die-cut-sticker" aria-hidden="true">
                {index + 1}
              </span>
              <h3 className="font-corp mt-2 text-lg font-bold text-varsity-navy">{step.title}</h3>
              <p className="mt-1 text-sm">{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="calculadora" aria-labelledby="calc-title" className="mx-auto w-full max-w-5xl scroll-mt-4 px-4 py-10">
        <h2 id="calc-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('calculator.title')}
        </h2>
        <p className="mb-6 mt-1 max-w-3xl text-ink-soft">{t('calculator.intro')}</p>
        <ImpactCalculator pricing={config.pricing} />
      </section>

      <section aria-labelledby="audiences-title" className="mx-auto w-full max-w-5xl px-4 py-10">
        <h2 id="audiences-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('audiences.title')}
        </h2>
        <div className="mobile-stack mt-6 grid gap-4 md:grid-cols-3">
          {audiences.map((card, index) => (
            <article key={card.title} className="korum-notebook-sheet flex flex-col gap-3">
              <h3 className="font-joy text-xl font-bold text-varsity-navy">{card.title}</h3>
              <ul className="flex flex-1 list-disc flex-col gap-1 ps-5 text-sm marker:text-varsity-gold-deep">
                {card.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
              <Link href={AUDIENCE_LINKS[index] ?? '/'} className="inline-flex min-h-11 items-center font-bold text-varsity-emerald underline underline-offset-4">
                {card.link}
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="money-title" className="mx-auto w-full max-w-3xl px-4 py-10">
        <div className="korum-trust-vault p-6">
          <h2 id="money-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
            {t('money.title')}
          </h2>
          <p className="mt-2">{t('money.text')}</p>
          <Link href="/seguridad-y-transparencia" className="mt-3 inline-flex min-h-11 items-center font-bold text-varsity-emerald underline underline-offset-4">
            {t('money.link')}
          </Link>
        </div>
      </section>

      <section aria-labelledby="final-title" className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 text-center">
        <h2 id="final-title" className="font-joy text-3xl font-bold text-varsity-navy">
          {t('final.title')}
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-ink-soft">{t('final.text')}</p>
        <Link href="/registro-comunidad" className="tactile-btn mt-5">
          {t('ctaSignup')}
        </Link>
      </section>
    </div>
  );
}
