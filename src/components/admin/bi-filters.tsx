import { useTranslations } from 'next-intl';
import type { BiFilters } from '@/core/finance/bi-summary';
import { Link } from '@/i18n/navigation';
import type { BiSnapshot } from '@/services/admin/bi-snapshot';
import { quarterParts } from './quarter-label';

const SELECT = 'min-h-11 w-full rounded-lg border-2 border-varsity-navy/30 bg-white px-3 text-base';

/**
 * Filtros globales del BI. Es un formulario normal (`GET`): los filtros viajan en la dirección web, así que funcionan sin JavaScript, se pueden
 * compartir y la página se genera siempre en el servidor con lo elegido.
 */
export function BiFiltersForm({ options, filters }: { options: BiSnapshot['options']; filters: BiFilters }) {
  const t = useTranslations('admin.filters');
  const tq = useTranslations('admin');
  const active = [filters.province, filters.organizationId, filters.health, filters.quarter].filter(Boolean).length;

  return (
    <form method="get" action="#negocio" className="korum-trust-vault flex flex-col gap-3 p-4" aria-labelledby="admin-filters-title" data-testid="bi-filters">
      <h3 id="admin-filters-title" className="font-corp text-lg font-extrabold text-varsity-navy">
        {t('title')}
        {active > 0 ? <span className="ms-2 rounded-full bg-varsity-gold/30 px-2 py-0.5 text-sm font-bold text-varsity-navy">{t('active', { count: active })}</span> : null}
      </h3>
      <div className="mobile-stack grid gap-3 md:grid-cols-4">
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink-soft">
          {t('province')}
          <select name="provincia" defaultValue={filters.province ?? ''} className={SELECT}>
            <option value="">{t('allProvinces')}</option>
            {options.provinces.map((province) => (
              <option key={province} value={province}>
                {province}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink-soft">
          {t('organization')}
          <select name="entidad" defaultValue={filters.organizationId ?? ''} className={SELECT}>
            <option value="">{t('allOrganizations')}</option>
            {options.organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {`${organization.name} (${organization.province})`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink-soft">
          {t('health')}
          <select name="estado" defaultValue={filters.health ?? ''} className={SELECT}>
            <option value="">{t('allHealth')}</option>
            <option value="OK">{t('health_OK')}</option>
            <option value="CALL">{t('health_CALL')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink-soft">
          {t('quarter')}
          <select name="trimestre" defaultValue={filters.quarter ?? ''} className={SELECT}>
            <option value="">{t('allQuarters')}</option>
            {options.quarters.map((quarter) => (
              <option key={quarter} value={quarter}>
                {quarterParts(quarter) ? tq('quarterLabel', quarterParts(quarter)!) : quarter}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="tactile-btn min-h-11 rounded-xl px-5 font-bold">
          {t('apply')}
        </button>
        {active > 0 ? (
          <Link href="/admin" className="inline-flex min-h-11 items-center px-2 font-semibold text-varsity-navy underline">
            {t('clear')}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
