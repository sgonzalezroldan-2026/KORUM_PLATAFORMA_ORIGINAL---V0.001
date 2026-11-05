import { getTranslations } from 'next-intl/server';
import { LOCALES } from '@/i18n/routing';
import { buildLlmsTxt, type LlmsSection } from '@/lib/seo/llms';
import { absoluteUrl, PILLAR_PAGES } from '@/lib/seo/marketing-routes';
import { fillTokensDeep, pricingTokens } from '@/lib/seo/pricing-tokens';
import { getPublicPlatformConfig } from '@/services/marketing/public-config';

// Las cifras salen de la consola: se releen cada 10 minutos.
export const revalidate = 600;

/** Texto sin interpretar: los catálogos llevan {marcas} de tarifas que se sustituyen después con `fillTokensDeep`. */
const text = (t: { raw: (key: string) => unknown }, key: string) => String(t.raw(key));

export async function GET() {
  const { pricing } = await getPublicPlatformConfig();
  const sections: LlmsSection[] = [];

  for (const locale of LOCALES) {
    const tokens = pricingTokens(pricing, locale);
    const llms = await getTranslations({ locale, namespace: 'marketing.llms' });
    const pages = await getTranslations({ locale, namespace: 'marketing.pages' });
    const languages = await getTranslations({ locale, namespace: 'languageSwitcher' });
    sections.push(
      fillTokensDeep(
        {
          locale,
          languageName: languages(locale),
          summary: text(llms, 'summary'),
          money: text(llms, 'money'),
          figuresTitle: text(llms, 'figuresTitle'),
          figures: llms.raw('figures') as string[],
          pagesTitle: text(llms, 'pagesTitle'),
          pages: PILLAR_PAGES.map((page) => ({ title: text(pages, `${page.key}.title`), description: text(pages, `${page.key}.description`), url: absoluteUrl(locale, page.path) }))
        },
        tokens
      )
    );
  }

  return new Response(buildLlmsTxt(sections), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=600' } });
}
