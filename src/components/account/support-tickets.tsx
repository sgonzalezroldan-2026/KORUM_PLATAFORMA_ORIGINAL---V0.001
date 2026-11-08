import { getFormatter, getTranslations } from 'next-intl/server';

export interface AccountTicket {
  ticketCode: string;
  topic: string;
  target: 'ORGANIZATION' | 'SUPERADMIN';
  subject: string;
  message: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
  replyMessage: string | null;
  createdAt: Date;
  originLabel: string;
  organization?: { slug: string } | null;
}

/**
 * «Mis consultas» (Sprint 3.9): las consultas de soporte de la persona con su estado en texto y la respuesta cuando la hay. La respuesta la
 * escribe el centro o la consola de KORUM (Sprints 4 y 5); aquí solo se lee. Las solicitudes de rectificación aparecen además en «Mis solicitudes».
 */
export async function SupportTickets({ tickets, helpHref }: { tickets: AccountTicket[]; helpHref: string | null }) {
  const [t, format] = await Promise.all([getTranslations('account.support'), getFormatter()]);

  return (
    <section id="support" aria-labelledby="support-title" className="flex scroll-mt-4 flex-col gap-3">
      <h2 id="support-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      {tickets.length === 0 ? (
        <p className="text-ink-soft" data-testid="support-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="support-list">
          {tickets.map((ticket) => (
            <li key={ticket.ticketCode} className="flex flex-col gap-1 rounded-2xl border-2 border-stone-200 bg-white p-4">
              <p className="flex flex-wrap items-center justify-between gap-2 font-extrabold text-varsity-navy">
                <span className="min-w-0 wrap-break-word">{`${ticket.ticketCode} · ${ticket.subject}`}</span>
                <span className="rounded-full border-2 border-stone-300 px-3 py-0.5 text-sm font-bold">{t(`status.${ticket.status}`)}</span>
              </p>
              <p className="text-sm text-ink-soft">
                {t('line', { topic: t(`topics.${ticket.topic}`), to: ticket.target === 'ORGANIZATION' ? ticket.originLabel : t('toKorum'), date: format.dateTime(ticket.createdAt, { dateStyle: 'medium', timeZone: 'Europe/Madrid' }) })}
              </p>
              {ticket.message ? (
                <details className="mt-1">
                  <summary className="min-h-11 cursor-pointer py-2 font-bold text-varsity-navy">{t('viewMessage')}</summary>
                  <p className="whitespace-pre-line wrap-break-word rounded-xl border border-stone-200 bg-stone-50 p-3">{ticket.message}</p>
                </details>
              ) : null}
              {ticket.replyMessage ? (
                <p className="mt-1 whitespace-pre-line wrap-break-word rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-950">
                  <span className="font-extrabold">{`${t('reply')} `}</span>
                  {ticket.replyMessage}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {helpHref ? (
        <a href={helpHref} className="inline-flex min-h-11 items-center self-start font-bold text-varsity-navy underline">
          {t('help')}
        </a>
      ) : (
        <p className="text-sm text-ink-soft">{t('helpNone')}</p>
      )}
    </section>
  );
}
