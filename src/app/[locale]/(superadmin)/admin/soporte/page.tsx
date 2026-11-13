import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { SupportTicketCard } from '@/components/admin/support-ticket-card';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { requireSuperadminAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { getConsoleSupport } from '@/repositories/console.repository';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'admin.support' });
  return { title: t('metaTitle') };
}

/**
 * Bandeja de soporte de KORUM (Sprint 5.3, prototipo `sa-sub-tickets`): las consultas dirigidas a la plataforma (pagos, cuenta, rectificación y otras) y lo que las
 * entidades escriben a KORUM desde su panel, estas primero. Se contesta una vez por consulta y el estado solo avanza (`OPEN → IN_PROGRESS → RESOLVED`). Las consultas
 * dirigidas a un centro no son de KORUM y no salen aquí.
 */
export default async function AdminSupportPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireSuperadminAccess(locale);
  const [view, t] = await Promise.all([getConsoleSupport(getPrisma(), actor), getTranslations({ locale, namespace: 'admin.support' })]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-8">
      <div className="flex flex-col gap-2">
        <Link href="/admin" className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline">
          {t('back')}
        </Link>
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
        <p className="text-ink-soft">{t('intro')}</p>
      </div>

      <section aria-labelledby="waiting-title" className="flex flex-col gap-3" data-testid="support-waiting">
        <h2 id="waiting-title" tabIndex={-1} className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('waitingTitle', { count: view.waitingCount, priority: view.priorityCount })}
        </h2>
        {view.waiting.length === 0 ? (
          <p className="text-ink-soft">{t('waitingNone')}</p>
        ) : (
          <>
            {view.waitingCount > view.waiting.length ? <p className="text-sm text-ink-soft">{t('capped', { shown: view.waiting.length, total: view.waitingCount })}</p> : null}
            <ol className="flex flex-col gap-3">
              {view.waiting.map((ticket) => (
                <SupportTicketCard key={ticket.ticketCode} ticket={ticket} />
              ))}
            </ol>
          </>
        )}
      </section>

      <section aria-labelledby="resolved-title" className="flex flex-col gap-3" data-testid="support-resolved">
        <h2 id="resolved-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('resolvedTitle')}
        </h2>
        {view.resolved.length === 0 ? (
          <p className="text-ink-soft">{t('resolvedNone')}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {view.resolved.map((ticket) => (
              <SupportTicketCard key={ticket.ticketCode} ticket={ticket} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
