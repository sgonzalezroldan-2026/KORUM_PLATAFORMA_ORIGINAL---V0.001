import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { AuditEntryList } from '@/components/audit/audit-entry-list';
import { AUDIT_FIELD, AUDIT_LABEL, AuditFilters, AuditPager } from '@/components/audit/audit-filters';
import { ENTITY_CATEGORIES } from '@/core/audit/audit-catalog';
import { activeAuditFilters, AUDIT_QUERY_KEYS, auditQueryString, distinctShortOptions, parseAuditQuery, shortOption } from '@/core/audit/audit-query';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { getEntityAudit } from '@/repositories/audit.repository';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: Locale; orgSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'audit.entity' });
  return { title: t('metaTitle') };
}

/**
 * Registro de actividad de la entidad (Sprint 5.8a, trazabilidad): la misma vista que la auditoría de la consola, pero **solo con lo suyo**. La entidad sale
 * de la ruta ya comprobada por la guardia del panel y toda la consulta lleva su identificador; no aparecen las consultas de KORUM, los ajustes de la
 * plataforma ni las tareas automáticas, y de las personas solo se nombran quienes firman hoy por ella. Solo lectura.
 */
export default async function PanelAuditPage({ params, searchParams }: Props) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const requested = parseAuditQuery(await searchParams, { allowUnclassified: false });
  const [view, t, roles] = await Promise.all([
    getEntityAudit(getPrisma(), actor, organization.id, requested),
    getTranslations({ locale, namespace: 'audit' }),
    getTranslations({ locale, namespace: 'panel.approvals.doubleCheck.roles' })
  ]);
  const query = view.applied;
  const base = `/panel/${organization.slug}/auditoria`;
  const { rows, nextBefore } = view.page;
  const filtered = activeAuditFilters(query) > 0;
  // En el desplegable va primero el cargo, que es lo que distingue a dos personas de nombre parecido cuando el texto se recorta; nunca quedan dos iguales.
  const memberLabels = view.members.map((member) => t('entity.memberOption', { name: member.name, role: member.roleLabel ?? roles(member.role as never) }));
  const memberOptions = distinctShortOptions(memberLabels);
  const newestHref = query.before ? `${base}${auditQueryString(query, { before: undefined })}` : null;
  const olderHref = nextBefore !== null ? `${base}${auditQueryString(query, { before: nextBefore })}` : null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('entity.title')}</h1>
        <p className="max-w-3xl text-ink-soft">{t('entity.intro')}</p>
        <p className="max-w-3xl text-sm text-ink-soft">{t('entity.privacy')}</p>
      </header>

      <AuditFilters query={query} categories={ENTITY_CATEGORIES} basePath={base} variant="entity">
        <label className={AUDIT_LABEL}>
          {t('entity.person')}
          <select name={AUDIT_QUERY_KEYS.person} defaultValue={query.personUserId ?? ''} className={AUDIT_FIELD}>
            <option value="">{t('entity.allPeople')}</option>
            {view.members.map((member, index) => (
              <option key={`${member.userId}-${member.role}`} value={member.userId} title={memberLabels[index]}>
                {memberOptions[index]}
              </option>
            ))}
          </select>
        </label>
        <label className={AUDIT_LABEL}>
          {t('entity.initiative')}
          <select name={AUDIT_QUERY_KEYS.initiative} defaultValue={query.initiativeId ?? ''} className={AUDIT_FIELD}>
            <option value="">{t('entity.allInitiatives')}</option>
            {view.initiatives.map((initiative) => (
              <option key={initiative.id} value={initiative.id} title={initiative.title}>
                {shortOption(t('entity.initiativeOption', { id: initiative.id, title: initiative.title }))}
              </option>
            ))}
          </select>
        </label>
      </AuditFilters>

      <section aria-labelledby="audit-list-title" className="flex flex-col gap-3">
        <h2 id="audit-list-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('list.title')}
        </h2>
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
            <AuditEntryList rows={rows} variant="entity" />
          </>
        )}
        <AuditPager position="bottom" newestHref={newestHref} olderHref={olderHref} />
      </section>
    </div>
  );
}
