import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Block } from '@/components/admin/entity-action';
import { ExemptCampaigns } from '@/components/admin/exempt-campaigns';
import { GlobalCategories } from '@/components/admin/global-categories';
import { GlobalRulesForm } from '@/components/admin/global-rules-form';
import { MedalsForm } from '@/components/admin/medals-form';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requireSuperadminAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { getConsoleRules } from '@/repositories/console.repository';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'admin.rules' });
  return { title: t('metaTitle') };
}

/**
 * Motor de reglas globales (Sprint 5.3, prototipo `sa-sub-rules`): lo que cobra la plataforma (pasarela, Mi Hucha, gastos de gestión digital, tramos, comercios, aportación
 * de garantía, mantenimiento), la duración de las campañas, las medallas y las categorías globales, con la salud de precios recalculada en vivo junto a cada campo.
 * Abrirla queda en la auditoría; guardar pide el segundo factor reciente. Ninguna regla de precios impide guardar.
 */
export default async function AdminRulesPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireSuperadminAccess(locale);
  const [view, t] = await Promise.all([getConsoleRules(getPrisma(), actor), getTranslations({ locale, namespace: 'admin.rules' })]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-2">
        <Link href="/admin" className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline">
          {t('back')}
        </Link>
        <h1 id="rules-title" tabIndex={-1} className="font-corp text-3xl font-extrabold text-varsity-navy outline-offset-4">
          {t('title')}
        </h1>
        <p className="text-ink-soft">{t('intro')}</p>
        <nav aria-label={t('nav.label')} className="flex flex-wrap gap-2">
          {(['pasarela', 'tramos', 'garantia', 'mantenimiento', 'duracion', 'medallas', 'categorias', 'campanas-exentas'] as const).map((anchor) => (
            <a key={anchor} href={`#${anchor}`} className="inline-flex min-h-11 items-center rounded-full border-2 border-varsity-navy/30 px-4 font-semibold text-varsity-navy hover:bg-varsity-navy/5">
              {t(`nav.${anchor}`)}
            </a>
          ))}
        </nav>
      </div>

      <GlobalRulesForm key={view.rules.version} rules={view.rules.rules} version={view.rules.version} margins={view.pricing.margins} acknowledgements={view.pricing.acknowledgements} />

      <Block id="medallas" title={t('medals.title')} hint={t('medals.hint')}>
        <MedalsForm key={view.medals.updatedAt} tiers={view.medals.tiers} updatedAt={view.medals.updatedAt} />
      </Block>

      <Block id="categorias" title={t('categories.title')} hint={t('categories.hint')}>
        <GlobalCategories categories={view.categories} />
      </Block>

      <Block id="campanas-exentas" title={t('exempt.title')} hint={t('exempt.hint')}>
        <ExemptCampaigns rows={view.exemptCampaigns} locale={locale} />
      </Block>
    </div>
  );
}
