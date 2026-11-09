import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { EntitySettingsForm } from '@/components/panel/entity-settings-form';
import { KybSection } from '@/components/panel/kyb-section';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { loadEntitySettings } from '@/services/panel/entity-settings-data';
import { FILE_RULES } from '@/services/storage/file-rules';

/**
 * Ajustes de la entidad (Sprint 4.2c, bloques KYB y «Valores de donación por defecto» de `sch-sub-moderation`): primero los documentos del titular
 * (lo que bloquea cobrar), después importes, ideas, teléfono y portal. Las dos personas firmantes los cambian; el Super-Admin los ve en solo
 * lectura. Dinámica: depende de la sesión.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'panel.settings' });
  return { title: t('metaTitle') };
}

export default async function EntitySettingsPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const [data, t, tRegistration] = await Promise.all([
    loadEntitySettings(getPrisma(), actor, organization.id),
    getTranslations({ locale, namespace: 'panel.settings' }),
    getTranslations({ locale, namespace: 'registration.legalForm' })
  ]);
  // El Super-Admin entra al panel para ayudar, pero no cambia los datos ni los documentos de la entidad.
  const canEdit = !actor.isSuperadmin && actor.memberships.some((membership) => membership.organizationId === organization.id && (membership.role === 'DIRECTOR' || membership.role === 'COSIGNER'));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-joy text-3xl font-bold text-varsity-navy">{t('title')}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
        {canEdit ? null : <p className="max-w-3xl rounded-xl border-2 border-varsity-navy/20 bg-varsity-ivory p-3 text-sm font-semibold text-varsity-navy">{t('readOnly')}</p>}
      </header>

      <section id="documentos" aria-labelledby="settings-kyb" className="flex scroll-mt-4 flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h2 id="settings-kyb" className="font-corp text-xl font-extrabold text-varsity-navy">
            {t('kyb.title')}
          </h2>
          <p className="max-w-3xl text-sm text-ink-soft">{t('kyb.intro')}</p>
        </header>
        <ApprovalsNoticeProvider>
          <KybSection orgSlug={organization.slug} kyb={data.kyb} canEdit={canEdit} maxBytes={FILE_RULES.KYB_DOCUMENT.maxBytes} legalFormLabel={tRegistration(data.kyb.legalForm as 'OTHER_NONPROFIT')} />
        </ApprovalsNoticeProvider>
      </section>

      <section aria-labelledby="settings-general" className="flex flex-col gap-4 border-t-2 border-varsity-navy/10 pt-6">
        <header className="flex flex-col gap-1">
          <h2 id="settings-general" className="font-corp text-xl font-extrabold text-varsity-navy">
            {t('general.title')}
          </h2>
          <p className="max-w-3xl text-sm text-ink-soft">{t('general.intro')}</p>
        </header>
        <ApprovalsNoticeProvider>
          <EntitySettingsForm orgSlug={organization.slug} initial={data.settings} canEdit={canEdit} />
        </ApprovalsNoticeProvider>
      </section>
    </div>
  );
}
