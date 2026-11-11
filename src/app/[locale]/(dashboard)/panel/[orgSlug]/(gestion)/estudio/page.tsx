import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { InitiativeCoverForm } from '@/components/panel/initiative-cover-form';
import { StudioPicker } from '@/components/panel/studio-picker';
import { StudioWorkbench, type StoredPricing } from '@/components/panel/studio-workbench';
import { findTemplate, draftFromTemplate } from '@/core/studio/campaign-templates';
import { effectiveMaxCampaignDays, latestCloseOn } from '@/core/studio/studio-board';
import { REWARD_PRESETS, blankStudioDraft, defaultCloseOn, madridIsoDate, type RewardPreset, type StudioDraft } from '@/core/studio/studio-draft';
import { Link } from '@/i18n/navigation';
import { FILE_RULES } from '@/services/storage/file-rules';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { INITIATIVE_ID_PATTERN } from '@/lib/seo/portal-routes';
import { MAX_OPEN_DRAFTS, getStudioInitiative, getStudioOverview, type StudioInitiative } from '@/repositories/studio.repository';
import { ResourceNotFoundError } from '@/repositories/tenant-guard';

/**
 * Estudio de edición de la entidad (Sprint 4.3, `sch-sub-studio`). Sin parámetros enseña el punto de entrada (campañas, empezar en blanco y plantillas);
 * con `?iniciativa=` abre esa campaña, y con `?nueva=presupuesto|taquilla` (y `&plantilla=`) empieza una nueva. Dinámica: depende de la sesión y de los
 * cupos de la entidad. Los textos que se guardan (plantillas y premios del reto) salen en el idioma en que escribe la entidad, no en el de quien edita.
 */
export const dynamic = 'force-dynamic';

const DEFAULT_CAMPAIGN_DAYS = 30;

/**
 * Una idea convertida nace con un cierre provisional a `maxCampaignDays` desde hoy, que con el cierre a las 23:59 ya pasa del máximo: en un borrador se
 * enseña el último día permitido en lugar de un error en cuanto se abre.
 */
function draftFromStored(initiative: StudioInitiative, firstReward: string, latestClose: string): StudioDraft {
  const stored = madridIsoDate(initiative.closesAt);
  const ticketing = initiative.format === 'TICKETING';
  return {
    initiativeId: initiative.id,
    format: initiative.format,
    title: initiative.title,
    category: initiative.category,
    stage: initiative.stage,
    closesOn: initiative.status === 'BUDGETING' && stored > latestClose ? latestClose : stored,
    description: initiative.description,
    showPublicBreakdown: initiative.showPublicBreakdown,
    plaqueEnabled: initiative.plaqueEnabled,
    rewardEnabled: initiative.rewardEnabled,
    rewardText: initiative.rewardEnabled ? (initiative.rewardText ?? firstReward) : initiative.rewardText,
    targetFamiliesPerCourse: initiative.targetFamiliesPerCourse,
    costMatCents: initiative.costMatCents,
    costInstCents: initiative.costInstCents,
    contingencyBps: initiative.contingencyBps,
    ticketSubtype: initiative.ticketSubtype ?? 'EVENT',
    ticketPriceCents: ticketing ? (initiative.ticketPriceCents ?? 0) : 500,
    ticketMax: ticketing ? (initiative.ticketMax ?? 0) : 200,
    ticketFeeMode: initiative.ticketFeeMode ?? 'ADD',
    ticketVenue: initiative.ticketVenue,
    rafflePrizeCount: initiative.rafflePrizeCount,
    raffleNoticeConfirmed: false
  };
}

export default async function StudioPage({ params, searchParams }: { params: Promise<{ locale: Locale; orgSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const query = await searchParams;
  const first = (name: string) => {
    const value = query[name];
    return typeof value === 'string' ? value : undefined;
  };
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const db = getPrisma();
  const now = new Date();
  const { context, initiatives, canCreate } = await getStudioOverview(db, actor, organization.id);
  const [t, tContent] = await Promise.all([getTranslations({ locale, namespace: 'panel.studio' }), getTranslations({ locale: context.contentLocale, namespace: 'panel.studio' })]);

  const rewardPresets = Object.fromEntries(REWARD_PRESETS.map((key) => [key, tContent(`rewardPresets.${key}`)])) as Record<RewardPreset, string>;
  const firstReward = rewardPresets[REWARD_PRESETS[0]];
  const maxDays = effectiveMaxCampaignDays(context.maxCampaignDays);
  const closeDefault = defaultCloseOn(now, Math.min(maxDays, DEFAULT_CAMPAIGN_DAYS));
  const common = { orgSlug, context, rewardPresets, nowIso: now.toISOString(), today: madridIsoDate(now), maxCloseOn: latestCloseOn(now, maxDays) };

  const idParam = first('iniciativa');
  const newParam = first('nueva');
  let workbench: React.ReactNode = null;
  let heading = t('title');

  if (idParam !== undefined) {
    if (!INITIATIVE_ID_PATTERN.test(idParam)) notFound();
    let initiative: StudioInitiative;
    try {
      initiative = await getStudioInitiative(db, actor, organization.id, Number(idParam));
    } catch (error) {
      if (error instanceof ResourceNotFoundError) notFound();
      throw error;
    }
    const lock = initiative.status === 'BUDGETING' ? 'NONE' : initiative.status === 'FUNDRAISING' ? 'SOFT' : 'ALL';
    const stored: StoredPricing = {
      status: initiative.status,
      walletEscrowId: initiative.walletEscrowId,
      raisedCents: initiative.raisedCents,
      goalCents: initiative.goalCents,
      maintFeeCents: initiative.maintFeeCents,
      defaultExemptAppliedCents: initiative.defaultExemptAppliedCents,
      medalExemptAppliedCents: initiative.medalExemptAppliedCents,
      bracketRateAppliedBps: initiative.bracketRateAppliedBps,
      bracketFeeCents: initiative.bracketFeeCents,
      gatewayFeeCents: initiative.gatewayFeeCents
    };
    heading = initiative.title;
    // Quien firma con el segundo factor puede cambiar la imagen; el Super-Admin la ve sin poder tocarla. Una campaña cancelada, vencida o reembolsada ya no se enseña.
    const canEditCover = !actor.isSuperadmin && ['BUDGETING', 'FUNDRAISING', 'GOAL_REACHED', 'CLOSED'].includes(initiative.status);
    workbench = (
      <>
        <StudioWorkbench key={initiative.id} {...common} initialDraft={draftFromStored(initiative, firstReward, common.maxCloseOn)} lock={lock} stored={stored} justPublished={first('publicada') === '1'} />
        <InitiativeCoverForm orgSlug={orgSlug} initiativeId={initiative.id} coverFileId={initiative.coverFileId} maxBytes={FILE_RULES.INITIATIVE_COVER.maxBytes} canEdit={canEditCover} canRemove={!actor.isSuperadmin && initiative.coverFileId !== null} />
      </>
    );
  } else if (newParam === 'presupuesto' || newParam === 'taquilla') {
    if (!canCreate) {
      return <StudioShell title={t('title')} back={t('back')} orgSlug={orgSlug}><StudioPicker locale={locale} orgSlug={orgSlug} vertical={context.vertical} canCreate={false} initiatives={initiatives} maxDrafts={MAX_OPEN_DRAFTS} /></StudioShell>;
    }
    const format = newParam === 'taquilla' ? 'TICKETING' : 'BUDGET';
    const template = findTemplate(first('plantilla'), context.vertical);
    let draft = blankStudioDraft(format, context.vertical, closeDefault);
    if (template && template.format === format) {
      draft = draftFromTemplate(
        template,
        { title: tContent(`templates.${template.key}.title`), description: tContent(`templates.${template.key}.description`), rewardText: firstReward },
        { vertical: context.vertical, defaultCloseOn: closeDefault, availableCategories: context.categories.map((category) => category.name) }
      );
    }
    heading = template ? t(`templates.${template.key}.name`) : t(format === 'TICKETING' ? 'picker.newTicketing' : 'picker.newBudget');
    workbench = (
      <>
        <StudioWorkbench key={`${newParam}:${template?.key ?? ''}`} {...common} initialDraft={{ ...draft, rewardText: draft.rewardText ?? firstReward }} lock="NONE" stored={null} justPublished={false} />
        <p className="text-sm font-semibold text-ink-soft" data-testid="cover-after-save">
          {t('cover.afterSave')}
        </p>
      </>
    );
  }

  return (
    <StudioShell title={heading} back={workbench ? t('back') : null} orgSlug={orgSlug}>
      {workbench ?? <StudioPicker locale={locale} orgSlug={orgSlug} vertical={context.vertical} canCreate={canCreate} initiatives={initiatives} maxDrafts={MAX_OPEN_DRAFTS} />}
    </StudioShell>
  );
}

async function StudioShell({ title, back, orgSlug, children }: { title: string; back: string | null; orgSlug: string; children: React.ReactNode }) {
  const t = await getTranslations('panel.studio');
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        {back ? (
          <Link href={`/panel/${orgSlug}/estudio`} className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline underline-offset-4">
            {back}
          </Link>
        ) : null}
        <h1 className="font-joy text-3xl font-bold text-varsity-navy wrap-anywhere">{title}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
      </header>
      {children}
    </div>
  );
}
