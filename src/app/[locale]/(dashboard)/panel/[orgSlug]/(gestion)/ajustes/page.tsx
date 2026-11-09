import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { EntityAccentForm } from '@/components/panel/entity-accent-form';
import { EntityBrandPreview } from '@/components/panel/entity-brand-preview';
import { EntityImageForm } from '@/components/panel/entity-image-form';
import { EntitySettingsForm } from '@/components/panel/entity-settings-form';
import { KybSection } from '@/components/panel/kyb-section';
import { ParticipationGroupsForm } from '@/components/panel/participation-groups-form';
import { SignerTeamSection } from '@/components/panel/signer-team-section';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getAuthSession } from '@/lib/auth/session';
import { getPrisma } from '@/lib/prisma';
import { loadEntitySettings } from '@/services/panel/entity-settings-data';
import { ENTITY_IMAGE_MAX_BYTES } from '@/services/panel/entity-branding.service';
import { loadSignerTeam } from '@/services/panel/signer-team.service';
import { publicFileSrc } from '@/services/portal/achievements-data';
import { FILE_RULES } from '@/services/storage/file-rules';

/**
 * Ajustes de la entidad (Sprint 4.2c, bloques KYB y «Valores de donación por defecto» de `sch-sub-moderation`): primero los documentos del titular
 * (lo que bloquea cobrar), el equipo que firma (Sprint 4.2e: relevo y cargos), después importes, ideas, teléfono y portal, los grupos de participación
 * y la identidad visual (logotipo, portada y color). Las dos personas firmantes los cambian; el Super-Admin los ve en solo lectura. Dinámica: depende
 * de la sesión.
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
  const [data, team, session, t, tRegistration] = await Promise.all([
    loadEntitySettings(getPrisma(), actor, organization.id),
    loadSignerTeam(getPrisma(), actor, organization.id),
    getAuthSession(),
    getTranslations({ locale, namespace: 'panel.settings' }),
    getTranslations({ locale, namespace: 'registration.legalForm' })
  ]);
  // El Super-Admin entra al panel para ayudar, pero no cambia los datos ni los documentos de la entidad.
  const logoSrc = data.brand.logoFileId ? publicFileSrc(data.brand.logoFileId) : null;
  const bannerSrc = data.brand.bannerFileId ? publicFileSrc(data.brand.bannerFileId) : null;
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

      <section id="equipo" aria-labelledby="settings-team" className="flex scroll-mt-4 flex-col gap-4 border-t-2 border-varsity-navy/10 pt-6">
        <header className="flex flex-col gap-1">
          <h2 id="settings-team" className="font-corp text-xl font-extrabold text-varsity-navy">
            {t('team.title')}
          </h2>
          <p className="max-w-3xl text-sm text-ink-soft">{t('team.intro')}</p>
        </header>
        <ApprovalsNoticeProvider>
          <SignerTeamSection orgSlug={organization.slug} team={team} canEdit={canEdit} email={session?.email ?? ''} />
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

      <section id="grupos" aria-labelledby="settings-groups" className="flex scroll-mt-4 flex-col gap-4 border-t-2 border-varsity-navy/10 pt-6">
        <header className="flex flex-col gap-1">
          <h2 id="settings-groups" className="font-corp text-xl font-extrabold text-varsity-navy">
            {t('groups.title')}
          </h2>
          <p className="max-w-3xl text-sm text-ink-soft">{t('groups.intro')}</p>
        </header>
        <ApprovalsNoticeProvider>
          <ParticipationGroupsForm orgSlug={organization.slug} blocks={data.groups.blocks} template={data.groups.template} canEdit={canEdit} />
        </ApprovalsNoticeProvider>
      </section>

      <section id="marca" aria-labelledby="settings-brand" className="flex scroll-mt-4 flex-col gap-4 border-t-2 border-varsity-navy/10 pt-6">
        <header className="flex flex-col gap-1">
          <h2 id="settings-brand" className="font-corp text-xl font-extrabold text-varsity-navy">
            {t('brand.title')}
          </h2>
          <p className="max-w-3xl text-sm text-ink-soft">{t('brand.intro')}</p>
        </header>
        <EntityBrandPreview name={data.brand.name} accent={data.brand.accentHex} logoSrc={logoSrc} bannerSrc={bannerSrc} />
        {/* Un solo aviso de éxito para el color, el logotipo y la portada (al quitar una imagen su botón desaparece: el foco va al aviso). */}
        <ApprovalsNoticeProvider>
          <div className="flex flex-col gap-4">
            <EntityAccentForm orgSlug={organization.slug} current={data.brand.accent} canEdit={canEdit} />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <EntityImageForm orgSlug={organization.slug} kind="logo" hasImage={logoSrc !== null} maxBytes={ENTITY_IMAGE_MAX_BYTES.logo} canEdit={canEdit} />
              <EntityImageForm orgSlug={organization.slug} kind="banner" hasImage={bannerSrc !== null} maxBytes={ENTITY_IMAGE_MAX_BYTES.banner} canEdit={canEdit} />
            </div>
          </div>
        </ApprovalsNoticeProvider>
      </section>
    </div>
  );
}
