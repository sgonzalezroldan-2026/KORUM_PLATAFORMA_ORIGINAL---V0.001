import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { OrgListTable } from '@/components/admin/org-list-table';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requireSuperadminAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { getConsoleOrganizations } from '@/repositories/console.repository';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'admin.entities' });
  return { title: t('metaTitle') };
}

/** Entidades de la plataforma (Sprint 5.2): primero las que esperan revisión del KYB, la más antigua arriba, y después todas, con su ficha 360º. */
export default async function AdminEntitiesPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireSuperadminAccess(locale);
  const [rows, t, format] = await Promise.all([getConsoleOrganizations(getPrisma(), actor), getTranslations({ locale, namespace: 'admin.entities' }), getFormatter({ locale })]);
  const waiting = rows.filter((row) => row.kybStatus === 'SUBMITTED' && !row.archived).sort((a, b) => (a.kybSubmittedAt ?? '').localeCompare(b.kybSubmittedAt ?? ''));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
      <div className="flex flex-col gap-2">
        <Link href="/admin" className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline">
          {t('back')}
        </Link>
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
      </div>

      <section aria-labelledby="waiting-title" className="flex flex-col gap-3" data-testid="kyb-waiting">
        <h2 id="waiting-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('waitingTitle', { count: waiting.length })}
        </h2>
        {waiting.length === 0 ? (
          <p className="text-ink-soft">{t('waitingNone')}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {waiting.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-amber-300 bg-amber-50 p-3">
                <span>
                  <strong>{row.name}</strong>
                  {` · ${row.province}`}
                  {row.kybSubmittedAt ? <span className="block text-sm text-ink-soft">{t('waitingSince', { date: format.dateTime(new Date(row.kybSubmittedAt), { dateStyle: 'medium', timeZone: 'Europe/Madrid' }) })}</span> : null}
                </span>
                <Link href={`/admin/entidades/${row.id}#kyb`} className="inline-flex min-h-11 items-center rounded-xl bg-varsity-navy px-4 font-bold text-white hover:bg-varsity-navy-deep" data-testid="review-kyb-link">
                  {t('review')}
                  <span className="sr-only">{` ${row.name}`}</span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="all-title" className="flex flex-col gap-3">
        <h2 id="all-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('allTitle', { count: rows.length })}
        </h2>
        <OrgListTable rows={rows} />
      </section>
    </div>
  );
}
