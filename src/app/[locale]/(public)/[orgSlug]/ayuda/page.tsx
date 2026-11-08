import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { PortalNav } from '@/components/portal/portal-nav';
import { JsonLd } from '@/components/seo/json-ld';
import { FaqList, type FaqItem } from '@/components/support/faq-list';
import { SupportForm } from '@/components/support/support-form';
import { isLocale } from '@/i18n/routing';
import { breadcrumbJsonLd, faqJsonLd } from '@/lib/seo/json-ld';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { buildPageMetadata, fitText, TITLE_MAX, TITLE_SUFFIX } from '@/lib/seo/metadata';
import { helpPath, portalPath } from '@/lib/seo/portal-routes';
import { loadHuchaMode, loadPortalOrganization } from '@/services/portal/portal-data';

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string }>;
}

const FAQ_IDS = ['guarantee', 'family', 'refund', 'payments', 'fiscal', 'ideas', 'hucha', 'data', 'independence'] as const;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) return {};
  const [organization, t] = await Promise.all([loadPortalOrganization(orgSlug), getTranslations({ locale, namespace: 'portal.meta' })]);
  const room = TITLE_MAX - TITLE_SUFFIX.length - t('helpTitle', { name: '' }).length;
  return buildPageMetadata({
    locale,
    path: helpPath(orgSlug),
    title: t('helpTitle', { name: fitText(organization.name, room) }),
    description: fitText(t('helpDescription', { name: organization.name }), 155),
    imageAlt: t('entityImageAlt', { name: organization.name }),
    noindex: !organization.indexable
  });
}

/**
 * FAQ y soporte (`id="fview-faq"` del prototipo; QA-F06). Las respuestas son las mismas para todas las familias, así que la página se genera una
 * vez y se comparte (como la portada): escribir exige sesión y eso se resuelve en el navegador, dentro del formulario. Las preguntas salen también
 * como datos estructurados `FAQPage`. Mi Hucha solo se explica si la plataforma la tiene activada como aportación mensual.
 */
export default async function HelpPage({ params }: PageProps) {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);

  const [organization, huchaMode, t, nav] = await Promise.all([
    loadPortalOrganization(orgSlug),
    loadHuchaMode(),
    getTranslations({ locale, namespace: 'portal.help' }),
    getTranslations({ locale, namespace: 'portal' })
  ]);
  const items: FaqItem[] = FAQ_IDS.filter((id) => id !== 'hucha' || huchaMode === 'PLEDGE').map((id) => ({ id, question: t(`items.${id}.q`), answer: t(`items.${id}.a`) }));
  const loginHref = `/login?next=${encodeURIComponent(localizedPath(locale, helpPath(orgSlug)))}`;

  return (
    <div className="space-y-6">
      <JsonLd
        data={[
          breadcrumbJsonLd(locale, [{ name: nav('breadcrumb.home'), path: '/' }, { name: organization.name, path: portalPath(orgSlug) }, { name: t('breadcrumb'), path: helpPath(orgSlug) }]),
          faqJsonLd(items.map((item) => ({ q: item.question, a: item.answer })))
        ]}
      />
      <PortalNav orgSlug={orgSlug} current="help" />

      <section aria-labelledby="help-title" className="rounded-3xl border border-amber-200 bg-amber-50 p-6">
        <p className="text-xs font-extrabold uppercase text-amber-900">{t('badge')}</p>
        <h1 id="help-title" className="font-joy text-2xl font-bold text-varsity-navy">
          {t('title')}
        </h1>
        <p className="mt-1 max-w-2xl text-ink-soft">{t('intro')}</p>
      </section>

      <div className="mobile-stack grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section aria-labelledby="faq-title" className="flex flex-col gap-3 lg:col-span-7">
          <h2 id="faq-title" className="font-joy text-xl font-bold text-varsity-navy">
            {t('faqTitle')}
          </h2>
          <FaqList items={items} label={t('faqTitle')} />
        </section>
        <section aria-labelledby="support-title" className="korum-trust-vault flex flex-col gap-3 p-5 lg:col-span-5">
          <h2 id="support-title" className="font-joy text-xl font-bold text-varsity-navy">
            <span aria-hidden="true">{'📬 '}</span>
            {t('support.title')}
          </h2>
          <p className="text-ink-soft">{t('support.intro')}</p>
          <SupportForm orgSlug={orgSlug} loginHref={loginHref} />
        </section>
      </div>
    </div>
  );
}
