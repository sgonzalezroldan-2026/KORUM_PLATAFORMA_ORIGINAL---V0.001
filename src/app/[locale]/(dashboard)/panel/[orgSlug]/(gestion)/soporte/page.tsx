import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { ApprovalsNoticeProvider } from '@/components/panel/approvals-notice';
import { SupportKorumForm } from '@/components/panel/support-korum-form';
import { SupportTicketCard } from '@/components/panel/support-ticket-card';
import { EmptyState } from '@/components/ui/empty-state';
import type { Locale } from '@/i18n/routing';
import { requirePanelAccess } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { loadSupportInbox } from '@/repositories/support-inbox.repository';

/**
 * Soporte del centro (Sprint 4.4c, prototipo `id="sch-sub-support"`): las consultas que las familias dirigen al centro, que contesta desde aquí sin ver
 * quién escribe, y el buzón prioritario de la entidad hacia KORUM. Dinámica: depende de la sesión. El Super-Admin la ve sin poder contestar ni escribir.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'panel.support' });
  return { title: t('metaTitle') };
}

export default async function SupportPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const { actor, organization } = await requirePanelAccess(locale, orgSlug);
  const [view, t, format] = await Promise.all([loadSupportInbox(getPrisma(), actor, organization.id), getTranslations({ locale, namespace: 'panel.support' }), getFormatter({ locale })]);
  const canAct = !actor.isSuperadmin && actor.memberships.some((membership) => membership.organizationId === organization.id && (membership.role === 'DIRECTOR' || membership.role === 'COSIGNER'));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
        <p className="max-w-3xl text-ink-soft">{t('intro')}</p>
      </header>
      <ApprovalsNoticeProvider>
        <section aria-labelledby="support-families" className="flex flex-col gap-3">
          <h2 id="support-families" className="font-corp text-2xl font-extrabold text-varsity-navy">
            {t('families.title')}
          </h2>
          <p className="max-w-3xl text-ink-soft">{t('families.intro')}</p>
          {view.families.waiting.length === 0 ? (
            <EmptyState icon="📭" title={t('families.empty.title')} description={t('families.empty.text')} headingLevel={3} />
          ) : (
            <>
              <h3 className="font-corp text-lg font-extrabold text-varsity-navy" data-testid="support-waiting-title">
                {t('families.waiting', { count: view.families.waitingCount })}
              </h3>
              {view.families.waitingCount > view.families.waiting.length ? <p className="text-sm font-semibold text-ink-soft">{t('families.waitingMore', { shown: view.families.waiting.length })}</p> : null}
              <ul className="flex flex-col gap-3" data-testid="support-waiting">
                {view.families.waiting.map((ticket) => (
                  <SupportTicketCard key={ticket.ticketCode} orgSlug={organization.slug} ticket={ticket} canAct={canAct} />
                ))}
              </ul>
            </>
          )}
          {view.families.resolved.length > 0 ? (
            <details className="rounded-2xl border-2 border-stone-200 bg-white p-4" data-testid="support-resolved">
              <summary className="min-h-11 cursor-pointer py-2 font-extrabold text-varsity-navy">{t('families.resolved', { count: view.families.resolved.length })}</summary>
              <ul className="mt-3 flex flex-col gap-3">
                {view.families.resolved.map((ticket) => (
                  <SupportTicketCard key={ticket.ticketCode} orgSlug={organization.slug} ticket={ticket} canAct={false} />
                ))}
              </ul>
            </details>
          ) : null}
        </section>

        <section aria-labelledby="support-korum" className="flex flex-col gap-3">
          <h2 id="support-korum" className="font-corp text-2xl font-extrabold text-varsity-navy">
            {t('korum.title')}
          </h2>
          <p className="max-w-3xl text-ink-soft">{t('korum.intro')}</p>
          <SupportKorumForm orgSlug={organization.slug} canAct={canAct} />
          <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('korum.sentTitle')}</h3>
          {view.sent.length === 0 ? (
            <p className="text-ink-soft" data-testid="support-sent-empty">
              {t('korum.sentEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-3" data-testid="support-sent">
              {view.sent.map((ticket) => (
                <li key={ticket.ticketCode} className="flex flex-col gap-1 rounded-2xl border-2 border-stone-200 bg-white p-4" data-ticket-code={ticket.ticketCode}>
                  <p className="flex flex-wrap items-center justify-between gap-2 font-extrabold text-varsity-navy">
                    <span className="min-w-0 wrap-break-word">{ticket.subject === '' ? ticket.ticketCode : `${ticket.ticketCode} · ${ticket.subject}`}</span>
                    <span className="rounded-full border-2 border-stone-300 px-3 py-0.5 text-sm font-bold">{t(`status.${ticket.status}`)}</span>
                  </p>
                  <p className="text-sm text-ink-soft">{t('line', { topic: t(`korum.topics.${ticket.topic === 'RECTIFICATION' ? 'OTHER' : ticket.topic}`), date: format.dateTime(new Date(ticket.createdAt), { dateStyle: 'medium', timeZone: 'Europe/Madrid' }) })}</p>
                  {ticket.replyMessage ? (
                    <p className="mt-1 whitespace-pre-line wrap-break-word rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-950">
                      <span className="font-extrabold">{`${t('korum.replyFrom')} `}</span>
                      {ticket.replyMessage}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </ApprovalsNoticeProvider>
    </div>
  );
}
