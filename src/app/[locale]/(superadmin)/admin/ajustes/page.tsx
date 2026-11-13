import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Block } from '@/components/admin/entity-action';
import { BackLink, UnsavedProvider } from '@/components/admin/settings/settings-kit';
import { CompanySettings, LegalSettings } from '@/components/admin/settings/settings-legal';
import { HistoryTable, SecurityPanel } from '@/components/admin/settings/settings-readonly';
import { AutoBoostSettings, EmailSettings, HuchaSettings, InvoicingSettings, LimitsSettings, PaymentsSettings } from '@/components/admin/settings/settings-sections';
import { SeoSettings } from '@/components/admin/settings/settings-seo';
import { TeamSettings } from '@/components/admin/settings/settings-team';
import { isLegalDocument, isLegalLocale, nextLegalVersion, type LegalDocument, type LegalLocale } from '@/core/admin/settings-model';
import type { Locale } from '@/i18n/routing';
import { requireSuperadminAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { DEFAULT_CRAWLER_POLICY } from '@/lib/seo/crawler-policy';
import { getConsoleSettings } from '@/repositories/console.repository';
import { HISTORY_MAX, HISTORY_PAGE } from '@/services/admin/platform-settings-view';
import { settingsRuntimeFromEnv } from '@/services/admin/settings-runtime';

export const dynamic = 'force-dynamic';

const SECTIONS = ['pagos', 'email', 'facturacion', 'hucha', 'autoimpulso', 'seo', 'textos', 'limites', 'equipo', 'seguridad', 'historial'] as const;

/** Vuelta al índice de bloques desde el final de cada uno: la página es larga y el índice queda arriba. */
function BackToIndex({ label }: { label: string }) {
  return (
    <a href="#settings-title" className="-mt-3 inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline">
      {label}
    </a>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'admin.settings' });
  return { title: t('metaTitle') };
}

/** `?texto=terminos.es` → qué texto legal se edita (por defecto, los términos en castellano). Cualquier otro valor se ignora. */
function parseText(value: string | string[] | undefined): { document: LegalDocument; locale: LegalLocale } | undefined {
  const [document, locale] = (typeof value === 'string' ? value : '').split('.');
  return isLegalDocument(document) && isLegalLocale(locale) ? { document, locale } : undefined;
}

function parseHistoryLimit(value: string | string[] | undefined): number {
  const parsed = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : HISTORY_PAGE;
  return Math.min(Math.max(parsed, HISTORY_PAGE), HISTORY_MAX);
}

/**
 * Ajustes de la plataforma (Sprint 5.4, prototipo `sa-sub-settings`): Paycomet y su modo, email y remitente, Veri*factu, Mi Hucha, Auto-Impulso, SEO y rastreadores de IA, textos legales
 * versionados, límites, equipo de Super-Admin, claves de cifrado e historial de cambios. Abrirla queda en la auditoría; guardar pide el segundo factor reciente (10 minutos). Los secretos son
 * de solo escritura: nunca se vuelven a mostrar.
 */
export default async function AdminSettingsPage({ params, searchParams }: { params: Promise<{ locale: Locale }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale } = await params;
  const query = await searchParams;
  setRequestLocale(locale);
  const { actor } = await requireSuperadminAccess(locale);
  const [view, t] = await Promise.all([
    getConsoleSettings(getPrisma(), actor, settingsRuntimeFromEnv(), { text: parseText(query.texto), historyLimit: parseHistoryLimit(query.historial) }),
    getTranslations({ locale, namespace: 'admin.settings' })
  ]);
  const suggestedVersion = nextLegalVersion(view.legal.selected.text?.version ?? null, new Date());

  return (
    <UnsavedProvider>
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-2">
          <BackLink label={t('back')} />
          <h1 id="settings-title" tabIndex={-1} className="font-corp text-3xl font-extrabold text-varsity-navy outline-offset-4">
            {t('title')}
          </h1>
          <p className="text-ink-soft">{t('intro')}</p>
          <nav aria-label={t('nav.label')} className="flex flex-wrap gap-2">
            {SECTIONS.map((anchor) => (
              <a
                key={anchor}
                href={`#${anchor}`}
                className="inline-flex min-h-11 items-center rounded-full border-2 border-varsity-navy/30 px-4 font-semibold text-varsity-navy hover:bg-varsity-navy/5"
              >
                {t(`nav.${anchor}`)}
              </a>
            ))}
          </nav>
        </div>

        <Block id="pagos" title={t('sections.pagos.title')} hint={t('sections.pagos.hint')}>
          <PaymentsSettings fields={view.fields} secrets={view.secrets} mode={view.paycometMode} />
        </Block>
        <BackToIndex label={t('backToIndex')} />
        <Block id="email" title={t('sections.email.title')} hint={t('sections.email.hint')}>
          <EmailSettings fields={view.fields} secrets={view.secrets} />
        </Block>
        <BackToIndex label={t('backToIndex')} />
        <Block id="facturacion" title={t('sections.facturacion.title')} hint={t('sections.facturacion.hint')}>
          <InvoicingSettings fields={view.fields} secrets={view.secrets} />
        </Block>
        <BackToIndex label={t('backToIndex')} />
        <Block id="hucha" title={t('sections.hucha.title')} hint={t('sections.hucha.hint')}>
          <HuchaSettings fields={view.fields} secrets={view.secrets} />
        </Block>
        <BackToIndex label={t('backToIndex')} />
        <Block id="autoimpulso" title={t('sections.autoimpulso.title')} hint={t('sections.autoimpulso.hint')}>
          <AutoBoostSettings fields={view.fields} />
        </Block>
        <BackToIndex label={t('backToIndex')} />
        <Block id="seo" title={t('sections.seo.title')} hint={t('sections.seo.hint')}>
          <SeoSettings fields={view.fields} secrets={view.secrets} defaultPolicy={DEFAULT_CRAWLER_POLICY} />
        </Block>
        <BackToIndex label={t('backToIndex')} />
        <Block id="textos" title={t('sections.textos.title')} hint={t('sections.textos.hint')}>
          <CompanySettings field={view.fields['platform.company']} />
          <LegalSettings overview={view.legal.overview} selected={view.legal.selected} policyVersion={view.legal.policyVersion} suggestedVersion={suggestedVersion} />
        </Block>
        <BackToIndex label={t('backToIndex')} />
        <Block id="limites" title={t('sections.limites.title')} hint={t('sections.limites.hint')}>
          <LimitsSettings fields={view.fields} fixedLimits={view.fixedLimits} />
        </Block>
        <BackToIndex label={t('backToIndex')} />
        <Block id="equipo" title={t('sections.equipo.title')} hint={t('sections.equipo.hint')}>
          <TeamSettings members={view.team.members} invitations={view.team.invitations} />
        </Block>
        <BackToIndex label={t('backToIndex')} />
        <Block id="seguridad" title={t('sections.seguridad.title')} hint={t('sections.seguridad.hint')}>
          <SecurityPanel security={view.security} />
        </Block>
        <BackToIndex label={t('backToIndex')} />
        <Block id="historial" title={t('sections.historial.title')} hint={t('sections.historial.hint')}>
          <HistoryTable history={view.history} />
        </Block>
        <BackToIndex label={t('backToIndex')} />
      </div>
    </UnsavedProvider>
  );
}
