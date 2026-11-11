'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { CurrencyText } from '@/components/ui/currency-text';
import { DelayedTooltip } from '@/components/ui/delayed-tooltip';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  DASHBOARD_STATUSES,
  NO_FILTERS,
  TIMELINE_STEPS,
  activeFilterCount,
  computeKpis,
  filterInitiatives,
  filterOptions,
  firstCampaignSteps,
  hasPublicPage,
  progressPercent,
  timelineStates,
  type DashboardFilters,
  type DashboardInitiative,
  type DashboardStatus
} from '@/core/panel/dashboard';
import { formatCents } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';

/**
 * Cuadro de mandos de la entidad (Sprint 4.1, `renderSchoolDashboard`): indicadores, filtros ocultos tras «Filtrar» (con contador si hay alguno
 * activo) y una tarjeta por iniciativa con su hucha `WLT-ESC-XXX` y la línea de 6 estados. Sin iniciativas, un estado vacío guiado hacia la primera
 * campaña. Los filtros se aplican en el navegador sobre lo que la guardia del servidor ya entregó para esta entidad.
 */

export interface DashboardBoardProps {
  orgSlug: string;
  initiatives: DashboardInitiative[];
  activeSponsors: number;
  readySigners: number;
  kybStatus: string;
}

const selectClass = 'min-h-11 rounded-xl border-2 border-varsity-navy bg-white px-3 text-base text-ink';

export function DashboardBoard({ orgSlug, initiatives, activeSponsors, readySigners, kybStatus }: DashboardBoardProps) {
  const t = useTranslations('panel.dashboard');
  const format = useFormatter();
  const current = useLocale();
  const money = (cents: number) => formatCents(cents, isLocale(current) ? current : 'es');
  const ids = { panel: useId(), year: useId(), category: useId(), status: useId() };
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<DashboardFilters>(NO_FILTERS);
  const options = useMemo(() => filterOptions(initiatives), [initiatives]);
  const visible = useMemo(() => filterInitiatives(initiatives, filters), [initiatives, filters]);
  const kpis = useMemo(() => computeKpis(visible), [visible]);
  const count = activeFilterCount(filters);

  if (initiatives.length === 0) {
    const steps = firstCampaignSteps({ readySigners, kybStatus });
    // Enviados y aún sin verificar: no «faltan», están en revisión (revisión de experiencia del 4.2c).
    const inReview = (key: string) => key === 'documents' && kybStatus === 'SUBMITTED';
    return (
      <section aria-label={t('empty.title')} className="flex flex-col gap-4">
        <EmptyState icon="🌱" title={t('empty.title')} description={t('empty.description')} playful className="korum-notebook-sheet" />
        <ol aria-label={t('empty.stepsLabel')} className="mobile-stack grid gap-3 md:grid-cols-3">
          {steps.map((step) => (
            <li key={step.key} className="korum-trust-vault flex flex-col gap-1 p-4">
              <p className="font-corp text-sm font-extrabold text-varsity-navy">
                <span aria-hidden="true">{step.done ? '✅ ' : inReview(step.key) ? '🔎 ' : '⏳ '}</span>
                {t(`empty.steps.${step.key}.title`)}
              </p>
              <p className="text-sm text-ink-soft">{inReview(step.key) ? t('empty.steps.documents.review') : t(`empty.steps.${step.key}.${step.done ? 'done' : 'todo'}`)}</p>
              {step.key === 'documents' && !step.done && !inReview(step.key) ? (
                <Link href={`/panel/${orgSlug}/ajustes#documentos`} className="inline-flex min-h-11 w-fit items-center text-sm font-bold text-varsity-navy underline underline-offset-4">
                  {t('empty.steps.documents.cta')}
                </Link>
              ) : null}
              {step.key === 'studio' ? (
                <Link href={`/panel/${orgSlug}/estudio`} className="inline-flex min-h-11 w-fit items-center text-sm font-bold text-varsity-navy underline underline-offset-4" data-testid="empty-studio-cta">
                  {t('empty.steps.studio.cta')}
                </Link>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    );
  }

  const kpiItems = [
    { key: 'total', value: String(kpis.total) },
    { key: 'active', value: String(kpis.active) },
    { key: 'achieved', value: String(kpis.achieved) },
    { key: 'raised', money: kpis.raisedCents },
    { key: 'sponsors', value: String(activeSponsors) }
  ] as const;

  return (
    <section aria-labelledby={`${ids.panel}-title`} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${ids.panel}-title`} className="font-corp text-sm font-extrabold uppercase tracking-wide text-ink-soft">
          {t('summaryTitle')}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
        <Link href={`/panel/${orgSlug}/estudio?nueva=presupuesto`} className="tactile-btn" data-testid="dashboard-new-initiative">
          {t('newInitiative')}
        </Link>
        <Link href={`/panel/${orgSlug}/estudio?nueva=taquilla`} className="tactile-btn" data-testid="dashboard-new-ticketing">
          {t('newTicketing')}
        </Link>
        <button
          type="button"
          className="inline-flex min-h-11 items-center gap-2 rounded-2xl border-2 border-varsity-navy bg-white px-4 font-corp text-sm font-extrabold text-varsity-navy"
          aria-expanded={open}
          aria-controls={ids.panel}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">{'🔍'}</span>
          {t('filter.toggle')}
          {count > 0 ? (
            <>
              {' '}
              <span className="rounded-full bg-varsity-navy px-2 py-0.5 text-xs text-varsity-ivory">{t('filter.count', { count })}</span>
            </>
          ) : null}
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
        </div>
      </div>

      <div id={ids.panel} hidden={!open} className="korum-trust-vault p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor={ids.year} className="flex flex-col gap-1 text-sm font-bold text-varsity-navy">
            {t('filter.year')}
            <select id={ids.year} className={selectClass} value={filters.year} onChange={(event) => setFilters({ ...filters, year: event.target.value })}>
              <option value="ALL">{t('filter.allYears')}</option>
              {options.years.map((year) => (
                <option key={year} value={year}>
                  {t('filter.course', { year })}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={ids.category} className="flex flex-col gap-1 text-sm font-bold text-varsity-navy">
            {t('filter.category')}
            <select id={ids.category} className={selectClass} value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
              <option value="ALL">{t('filter.allCategories')}</option>
              {options.categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={ids.status} className="flex flex-col gap-1 text-sm font-bold text-varsity-navy">
            {t('filter.status')}
            <select id={ids.status} className={selectClass} value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as DashboardStatus | 'ALL' })}>
              <option value="ALL">{t('filter.allStatuses')}</option>
              {DASHBOARD_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`filter.statusOption.${status}`)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="min-h-11 font-bold text-varsity-navy underline underline-offset-4" onClick={() => setFilters(NO_FILTERS)}>
            {t('filter.reset')}
          </button>
        </div>
      </div>

      <p role="status" className="sr-only">
        {t('resultCount', { count: visible.length })}
      </p>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {kpiItems.map((item) => (
          <div key={item.key} className="korum-trust-vault p-4">
            <dt className="text-xs font-extrabold uppercase text-ink-soft">{t(`kpi.${item.key}`)}</dt>
            <dd className="font-corp text-2xl font-extrabold tabular-nums text-varsity-navy">{'money' in item ? <CurrencyText cents={item.money} /> : item.value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-col gap-1">
        <h2 className="font-joy text-lg font-bold text-varsity-navy">{t('timeline.title')}</h2>
        <p className="text-sm text-ink-soft">{t('timeline.intro')}</p>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon="🔍" title={t('noMatch.title')} description={t('noMatch.description')} action={<button type="button" className="tactile-btn" onClick={() => setFilters(NO_FILTERS)}>{t('filter.reset')}</button>} />
      ) : (
        <ul className="flex flex-col gap-4" aria-label={t('timeline.listLabel')}>
          {visible.map((item) => {
            const states = timelineStates(item.stepIndex);
            const currentStep = TIMELINE_STEPS[Math.min(Math.max(item.stepIndex, 0), TIMELINE_STEPS.length - 1)]!;
            const percent = progressPercent(item.raisedCents, item.goalCents);
            return (
              <li key={item.id} className="korum-notebook-sheet flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-ink-soft">
                      <span>
                        <span aria-hidden="true">{item.format === 'TICKETING' ? '🎟️ ' : '🏗️ '}</span>
                        {t(item.format === 'TICKETING' ? 'card.formatTicketing' : 'card.formatBudget')}
                      </span>
                      <span>{t('card.hucha', { id: item.walletEscrowId })}</span>
                    </p>
                    <h3 className="wrap-break-word font-joy text-lg font-bold text-varsity-navy">{item.title}</h3>
                  </div>
                  <StatusBadge status={item.status} />
                </div>

                <div className="flex flex-col gap-1">
                  <p className="font-corp text-sm font-bold tabular-nums text-varsity-navy">
                    {t('card.raised', { raised: money(item.raisedCents), goal: money(item.goalCents) })}
                  </p>
                  <progress className="h-2 w-full overflow-hidden rounded-full accent-varsity-emerald" max={100} value={percent} aria-label={t('card.progress', { title: item.title, percent })} />
                  <p className="flex flex-wrap gap-x-4 text-sm text-ink-soft">
                    <span>{t('card.contributions', { count: item.totalContributions })}</span>
                    {item.status === 'FUNDRAISING' ? <span>{t('card.closes', { date: format.dateTime(new Date(item.closesAt), { dateStyle: 'long', timeZone: 'Europe/Madrid' }) })}</span> : null}
                  </p>
                </div>

                <ol aria-label={t('timeline.stepsLabel', { title: item.title })} className="grid grid-cols-2 gap-1.5 sm:grid-cols-6">
                  {TIMELINE_STEPS.map((step, index) => (
                    <li
                      key={step}
                      aria-current={states[index] === 'current' ? 'step' : undefined}
                      className={`rounded-lg px-2 py-1.5 text-center text-xs font-bold ${states[index] === 'current' ? 'bg-varsity-navy text-varsity-ivory' : states[index] === 'done' ? 'bg-emerald-100 text-emerald-950' : 'bg-white text-ink-soft ring-1 ring-varsity-navy/15'}`}
                    >
                      <DelayedTooltip content={t(`stepTip.${step}`)} className="block">
                        <span tabIndex={0} className="block rounded-md">
                          {t(`steps.${step}`)}
                          <span className="sr-only">{` (${t(`stepState.${states[index]!}`)})`}</span>
                        </span>
                      </DelayedTooltip>
                    </li>
                  ))}
                </ol>
                <p className="text-sm text-ink-soft">{t('timeline.now', { step: t(`steps.${currentStep}`), hint: t(`stepTip.${currentStep}`) })}</p>

                <div className="flex flex-wrap gap-x-5">
                  <Link href={`/panel/${orgSlug}/estudio?iniciativa=${item.id}`} className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline underline-offset-4" data-testid={`edit-in-studio-${item.id}`}>
                    <span aria-hidden="true">{'✏️ '}</span>
                    {t('card.editInStudio', { title: item.title })}
                  </Link>
                  {item.status === 'FUNDRAISING' ? (
                    <Link href={`/panel/${orgSlug}/estudio/${item.id}/cartel`} className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline underline-offset-4">
                      <span aria-hidden="true">{'🖨️ '}</span>
                      {t('card.poster', { title: item.title })}
                    </Link>
                  ) : null}
                  {item.status === 'GOAL_REACHED' ? (
                    <Link href={`/panel/${orgSlug}/liquidaciones`} className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline underline-offset-4" data-testid={`settle-${item.id}`}>
                      <span aria-hidden="true">{'🏆 '}</span>
                      {t('card.settle', { title: item.title })}
                    </Link>
                  ) : null}
                  {hasPublicPage(item.status) ? (
                    <Link href={`/${orgSlug}/iniciativas/${item.id}`} className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline underline-offset-4">
                      {t('card.viewPublic', { title: item.title })}
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
