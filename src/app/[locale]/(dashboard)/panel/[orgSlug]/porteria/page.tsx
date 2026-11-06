import { getTranslations, setRequestLocale } from 'next-intl/server';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { listGateEvents } from '@/repositories/public.repository';

export const dynamic = 'force-dynamic';

/** Elección del evento en la puerta: solo los que tienen un PIN vigente. */
export default async function GateEventsPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'gate' });
  const events = await listGateEvents(getPrisma(), orgSlug);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-corp text-2xl font-extrabold">{t('chooseTitle')}</h1>
      {events.length === 0 ? (
        <div className="rounded-2xl bg-varsity-ivory p-4 text-ink">
          <EmptyState title={t('emptyTitle')} description={t('emptyText')} />
        </div>
      ) : (
        <ul className="mobile-stack grid gap-3 md:grid-cols-2">
          {events.map((event) => (
            <li key={event.id}>
              <Link href={`/panel/${orgSlug}/porteria/${event.id}`} className="flex min-h-14 items-center rounded-xl bg-varsity-ivory px-4 py-3 font-bold text-varsity-navy hover:bg-white">
                <span aria-hidden="true">{'🎟️ '}</span>
                {event.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
