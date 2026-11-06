'use client';

import clsx from 'clsx';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { countActiveFilters, matchesFilters, NO_FILTERS, distinctOptions, type CatalogFilters, type UrgencyFilter } from '@/core/public/catalog';
import type { InitiativeCardData } from '@/core/public/view-model';
import { InitiativeCard } from './initiative-card';
import { ShareModal, type ShareGroup, type ShareTarget } from './share-modal';

export interface InitiativeCatalogProps {
  orgSlug: string;
  entityName: string;
  cards: InitiativeCardData[];
  /** URL absoluta y canónica de la ficha de cada iniciativa, por identificador. */
  urls: Record<number, string>;
  groups: ShareGroup[];
  contentLang?: string;
}

const URGENCY_OPTIONS: readonly UrgencyFilter[] = ['ALL', 'SOON', 'ALMOST', 'TICKETING'];
const selectClass = 'min-h-11 w-full rounded-xl border-2 border-patio-rule-strong bg-white px-3 font-semibold text-ink';

/**
 * Listado de «Iniciativas y taquilla» (`id="fview-activas"`). Solo recibe campañas `FUNDRAISING`. Los filtros están **ocultos al cargar** y se
 * despliegan con `🔍 Filtrar`, que muestra cuántos hay activos (QA-F01). Filtrar es instantáneo y en el navegador: no hay nada que recargar.
 */
export function InitiativeCatalog({ orgSlug, entityName, cards, urls, groups, contentLang }: InitiativeCatalogProps) {
  const t = useTranslations('portal');
  const locale = useLocale();
  const panelId = useId();
  const categoryId = useId();
  const urgencyId = useId();
  const stageId = useId();
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<CatalogFilters>(NO_FILTERS);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);

  const categories = useMemo(() => distinctOptions(cards.map((card) => card.category), locale), [cards, locale]);
  const stages = useMemo(() => distinctOptions(cards.map((card) => card.stage), locale), [cards, locale]);
  const visible = useMemo(() => cards.filter((card) => matchesFilters(card, filters)), [cards, filters]);
  const active = countActiveFilters(filters);

  if (cards.length === 0) {
    return <EmptyState icon="🌱" playful title={t('catalog.empty.title')} description={t('catalog.empty.description')} />;
  }

  return (
    <section id="fview-activas" aria-labelledby="catalog-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="catalog-heading" className="font-joy text-xl font-bold text-varsity-navy">
          {t('catalog.heading')}
        </h2>
        <button
          type="button"
          id="family-filter-toggle-btn"
          ref={toggleRef}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex min-h-11 items-center gap-2 rounded-2xl border-2 border-patio-rule-strong bg-white px-4 font-extrabold text-varsity-navy hover:bg-patio-cream"
        >
          <span aria-hidden="true">{'🔍'}</span>
          {t('filter.toggle')}
          {active > 0 ? (
            <span className="rounded-full bg-varsity-navy px-2 py-0.5 text-sm text-varsity-ivory" aria-label={t('filter.activeCount', { count: active })}>
              {active}
            </span>
          ) : null}
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      </div>

      <div id={panelId} hidden={!open} className="rounded-2xl border border-patio-rule-strong bg-white p-4" data-testid="family-filters-bar">
        <p className="mb-3 font-bold text-ink-soft">{t('filter.title')}</p>
        <div className="mobile-stack grid gap-3 md:grid-cols-3">
          <div>
            <label htmlFor={categoryId} className="mb-1 block text-sm font-bold text-varsity-navy">
              {t('filter.category')}
            </label>
            <select id={categoryId} className={selectClass} value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
              <option value="">{t('filter.allCategories')}</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={urgencyId} className="mb-1 block text-sm font-bold text-varsity-navy">
              {t('filter.urgency')}
            </label>
            <select id={urgencyId} className={selectClass} value={filters.urgency} onChange={(event) => setFilters({ ...filters, urgency: event.target.value as UrgencyFilter })}>
              {URGENCY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {t(`filter.urgencyOptions.${option}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={stageId} className="mb-1 block text-sm font-bold text-varsity-navy">
              {t('filter.stage')}
            </label>
            <select id={stageId} className={selectClass} value={filters.stage} onChange={(event) => setFilters({ ...filters, stage: event.target.value })}>
              <option value="">{t('filter.allStages')}</option>
              {stages.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button type="button" onClick={() => setFilters(NO_FILTERS)} disabled={active === 0} className="mt-3 inline-flex min-h-11 items-center rounded-xl px-3 font-bold text-varsity-navy underline underline-offset-4 disabled:opacity-60">
          {t('filter.clear')}
        </button>
      </div>

      {/* Anuncia cuántas quedan tras filtrar sin mover el foco. */}
      <p role="status" aria-live="polite" className={clsx('text-sm font-semibold text-ink-soft', active === 0 && 'sr-only')}>
        {t('filter.results', { count: visible.length })}
      </p>

      {visible.length === 0 ? (
        <EmptyState
          icon="🔎"
          playful
          title={t('catalog.noMatch.title')}
          description={t('filter.results', { count: 0 })}
          action={
            <button
              type="button"
              onClick={() => {
                setFilters(NO_FILTERS);
                // El botón desaparece al limpiar: el foco pasa al control que lo abrió, no se pierde.
                toggleRef.current?.focus();
              }}
              className="tactile-btn"
            >
              {t('catalog.noMatch.reset')}
            </button>
          }
        />
      ) : (
        <div id="family-campaigns-grid" className="mobile-stack grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((card) => (
            <InitiativeCard
              key={card.id}
              orgSlug={orgSlug}
              card={card}
              contentLang={contentLang}
              shareButton={
                <button
                  type="button"
                  aria-label={t('card.share', { title: card.title })}
                  onClick={() => setShareTarget({ title: card.title, entityName, url: urls[card.id] ?? '', groups })}
                  className="inline-flex size-11 items-center justify-center rounded-full bg-white text-lg shadow-sm hover:bg-patio-cream"
                >
                  <span aria-hidden="true">{'📤'}</span>
                </button>
              }
            />
          ))}
        </div>
      )}

      <ShareModal target={shareTarget} onClose={() => setShareTarget(null)} />
    </section>
  );
}
