import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { auditActionsOf, ENTITY_PROBE_ACTION, ENTITY_VISIBLE_ACTIONS, PROBE_ACTIONS, type AuditCategory } from '@/core/audit/audit-catalog';
import { activeAuditFilters, AUDIT_QUERY_KEYS, shortOption, type AuditQuery } from '@/core/audit/audit-query';
import { Link } from '@/i18n/navigation';

/**
 * Filtros del visor de la auditoría (Sprint 5.8a). Formulario normal (`GET`, sin `action`: vuelve a la misma página): los filtros viajan en la dirección,
 * funcionan sin JavaScript y la página se pinta siempre en el servidor. Plegados al cargar (Regla 03 §2) con el número de filtros puestos; se abren solos
 * cuando hay alguno, para que se vea por qué la lista es más corta. Los filtros propios de cada alcance (entidad y persona en la consola; firmante y
 * campaña en el panel) llegan como `children`. En el panel solo se ofrecen las acciones que la entidad puede ver. Componente de servidor (asíncrono: lee
 * los textos con la API de servidor).
 */

export const AUDIT_FIELD = 'min-h-11 w-full rounded-lg border-2 border-varsity-navy/30 bg-white px-3 text-base text-varsity-navy';
export const AUDIT_LABEL = 'flex flex-col gap-1 text-sm font-semibold text-ink-soft';

export async function AuditFilters({
  query,
  categories,
  basePath,
  variant,
  children
}: {
  query: AuditQuery;
  categories: readonly (AuditCategory | 'unclassified')[];
  basePath: string;
  variant: 'console' | 'entity';
  children?: ReactNode;
}) {
  const [t, actions] = await Promise.all([getTranslations('audit'), getTranslations('audit.actions')]);
  const active = activeAuditFilters(query);
  const real = categories.filter((category): category is AuditCategory => category !== 'unclassified');
  // En el panel: solo lo que la entidad puede ver, y los dos sondeos de recursos como uno solo.
  const offered = (category: AuditCategory) =>
    variant === 'console' ? auditActionsOf(category) : auditActionsOf(category).filter((action) => ENTITY_VISIBLE_ACTIONS.includes(action) && (!PROBE_ACTIONS.includes(action) || action === ENTITY_PROBE_ACTION));
  const labelOf = (action: string) => (variant === 'entity' && action === ENTITY_PROBE_ACTION ? t('entity.probe') : actions(action as never));
  const chosenAction = variant === 'entity' && query.action && PROBE_ACTIONS.includes(query.action) ? ENTITY_PROBE_ACTION : (query.action ?? '');

  return (
    <details className="korum-trust-vault p-4" open={active > 0} data-testid="audit-filters">
      <summary className="inline-flex min-h-11 cursor-pointer items-center gap-2 font-corp text-lg font-extrabold text-varsity-navy">
        <span aria-hidden="true">{'🔍'}</span>
        {t('filters.toggle')}
        {active > 0 ? (
          <span className="rounded-full bg-varsity-gold/30 px-2 py-0.5 text-sm font-bold text-varsity-navy" data-testid="audit-filters-active">
            {t('filters.active', { count: active })}
          </span>
        ) : null}
      </summary>
      <form method="get" className="mt-3 flex flex-col gap-3">
        <div className="mobile-stack grid gap-3 md:grid-cols-2">
          <label className={AUDIT_LABEL}>
            {t('filters.category')}
            <select name={AUDIT_QUERY_KEYS.category} defaultValue={query.category ?? ''} className={AUDIT_FIELD}>
              <option value="">{t('filters.allCategories')}</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {t(`categories.${category}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={AUDIT_LABEL}>
            {t('filters.action')}
            <select name={AUDIT_QUERY_KEYS.action} defaultValue={chosenAction} className={AUDIT_FIELD}>
              <option value="">{t('filters.allActions')}</option>
              {real.map((category) => (
                <optgroup key={category} label={t(`categories.${category}`)}>
                  {offered(category).map((action) => (
                    <option key={action} value={action} title={labelOf(action)}>
                      {shortOption(labelOf(action))}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {children}
          <label className={AUDIT_LABEL}>
            {t('filters.from')}
            <input type="date" name={AUDIT_QUERY_KEYS.from} defaultValue={query.fromDay ?? ''} className={AUDIT_FIELD} />
          </label>
          <label className={AUDIT_LABEL}>
            {t('filters.to')}
            <input type="date" name={AUDIT_QUERY_KEYS.to} defaultValue={query.toDay ?? ''} className={AUDIT_FIELD} />
          </label>
        </div>
        <p className="text-sm text-ink-soft">{t('filters.hint')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="tactile-btn min-h-11 rounded-xl px-5 font-bold">
            {t('filters.apply')}
          </button>
          {active > 0 ? (
            <Link href={basePath} className="inline-flex min-h-11 items-center font-semibold text-varsity-navy underline" data-testid="audit-filters-clear">
              {t('filters.clear')}
            </Link>
          ) : null}
        </div>
      </form>
    </details>
  );
}

/** Enlaces de paginación del visor: arriba y abajo de la lista, para no tener que recorrer 50 registros en el móvil. */
export async function AuditPager({ newestHref, olderHref, position }: { newestHref: string | null; olderHref: string | null; position: 'top' | 'bottom' }) {
  if (!newestHref && !olderHref) return null;
  const t = await getTranslations('audit.list');
  const link = 'inline-flex min-h-11 items-center font-semibold text-varsity-navy underline';
  return (
    <nav aria-label={t(position === 'top' ? 'pagerTop' : 'pagerBottom')} className="flex flex-wrap gap-4">
      {newestHref ? (
        <Link href={newestHref} className={link} data-testid={`audit-newest-${position}`}>
          {t('newest')}
        </Link>
      ) : null}
      {olderHref ? (
        <Link href={olderHref} className={link} data-testid={`audit-older-${position}`}>
          {t('older')}
        </Link>
      ) : null}
    </nav>
  );
}
