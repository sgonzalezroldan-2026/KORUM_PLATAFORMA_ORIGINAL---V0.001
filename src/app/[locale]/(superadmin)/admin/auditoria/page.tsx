import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AuditPersonSearch } from '@/components/admin/audit-person-search';
import { AuditEntryList } from '@/components/audit/audit-entry-list';
import { AUDIT_FIELD, AUDIT_LABEL, AuditFilters, AuditPager } from '@/components/audit/audit-filters';
import { AUDIT_CATEGORIES } from '@/core/audit/audit-catalog';
import { activeAuditFilters, AUDIT_QUERY_KEYS, auditQueryString, distinctShortOptions, parseAuditQuery } from '@/core/audit/audit-query';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requireSuperadminAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { getConsoleAudit } from '@/repositories/audit.repository';
import { hidesKorumAccess } from '@/services/audit/audit-viewer.service';

export const dynamic = 'force-dynamic';

const BASE = '/admin/auditoria';
const CATEGORIES = [...AUDIT_CATEGORIES, 'unclassified'] as const;

type Props = { params: Promise<{ locale: Locale }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'audit.console' });
  return { title: t('metaTitle') };
}

/**
 * Visor de la auditoría en la consola del Super-Admin (Sprint 5.8a, trazabilidad): quién hizo qué, cuándo y desde dónde en toda la plataforma, con búsqueda
 * por persona, entidad, campaña, tipo de actividad, acción y fechas. Solo lectura: `AuditLog` no se edita ni se borra. Abrirlo queda anotado, como el resto
 * de la consola.
 */
export default async function AdminAuditPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireSuperadminAccess(locale);
  const query = parseAuditQuery(await searchParams, { allowUnclassified: true });
  const [view, t] = await Promise.all([getConsoleAudit(getPrisma(), actor, query), getTranslations({ locale, namespace: 'audit' })]);
  const { rows, nextBefore } = view.page;
  const filtered = activeAuditFilters(query) > 0;
  // Muchos colegios empiezan igual («AMPA del CEIP Nuestra Señora…»): recortados, los que coinciden conservan el final del nombre y nunca quedan dos iguales.
  const organizationOptions = distinctShortOptions(view.organizations.map((organization) => organization.name));
  const newestHref = query.before ? `${BASE}${auditQueryString(query, { before: undefined })}` : null;
  const olderHref = nextBefore !== null ? `${BASE}${auditQueryString(query, { before: nextBefore })}` : null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-2">
        <Link href="/admin" className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline">
          {t('console.back')}
        </Link>
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('console.title')}</h1>
        <p className="text-ink-soft">{t('console.intro')}</p>
      </div>

      <AuditPersonSearch />
      {query.personUserId ? (
        <div className="korum-trust-vault flex flex-wrap items-center gap-x-4 gap-y-1 p-4" role="status" data-testid="audit-person-filter">
          <p className="font-semibold text-varsity-navy">
            {view.personNotFound || !view.person
              ? t('console.personNotFound')
              : view.person.erased || !view.person.email
                ? t('console.personErased')
                : view.person.name
                  ? t('console.personFiltered', { name: view.person.name, email: view.person.email })
                  : t('console.personFilteredNoName', { email: view.person.email })}
          </p>
          <Link href={`${BASE}${auditQueryString(query, { personUserId: undefined, before: undefined })}`} className="inline-flex min-h-11 items-center font-semibold text-varsity-navy underline">
            {t('console.personClear')}
          </Link>
        </div>
      ) : null}

      <AuditFilters query={query} categories={CATEGORIES} basePath={BASE} variant="console">
        {query.personUserId ? <input type="hidden" name={AUDIT_QUERY_KEYS.person} value={query.personUserId} /> : null}
        <label className={AUDIT_LABEL}>
          {t('console.organization')}
          <select name={AUDIT_QUERY_KEYS.organization} defaultValue={query.organizationId ?? ''} className={AUDIT_FIELD}>
            <option value="">{t('console.allOrganizations')}</option>
            {view.organizations.map((organization, index) => (
              <option key={organization.id} value={organization.id} title={organization.name}>
                {organizationOptions[index]}
              </option>
            ))}
          </select>
        </label>
        <label className={AUDIT_LABEL}>
          {t('filters.initiativeNumber')}
          <input type="number" name={AUDIT_QUERY_KEYS.initiative} defaultValue={query.initiativeId ?? ''} min={1} step={1} inputMode="numeric" className={AUDIT_FIELD} />
        </label>
      </AuditFilters>

      <section aria-labelledby="audit-list-title" className="flex flex-col gap-3">
        <h2 id="audit-list-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('list.title')}
        </h2>
        {hidesKorumAccess(query) ? (
          <p className="text-sm text-ink-soft" data-testid="audit-korum-hidden">
            {`${t('console.korumHidden')} `}
            <Link href={`${BASE}${auditQueryString(query, { category: 'korumAccess', before: undefined })}`} className="inline-flex min-h-11 items-center font-semibold text-varsity-navy underline">
              {t('console.korumShow')}
            </Link>
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-ink-soft" data-testid="audit-empty">
            {filtered || query.before ? t('list.emptyFiltered') : t('list.empty')}
          </p>
        ) : (
          <>
            <p className="text-sm text-ink-soft" data-testid="audit-count">
              {t('list.count', { count: rows.length })}
            </p>
            <AuditPager position="top" newestHref={newestHref} olderHref={olderHref} />
            <AuditEntryList rows={rows} variant="console" />
          </>
        )}
        <AuditPager position="bottom" newestHref={newestHref} olderHref={olderHref} />
      </section>
    </div>
  );
}
