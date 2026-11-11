import { getTranslations, setRequestLocale } from 'next-intl/server';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';

export const dynamic = 'force-dynamic';

/**
 * Entrada general de la portería. **No lista eventos** (Sprint 4.7): el identificador del evento no se muestra en público y la puerta de cada evento se abre con su
 * enlace (con un código no adivinable) y su PIN, que da quien organiza. Sin consultar nada: tampoco hay nada que contar contra el límite de la red.
 */
export default async function GateEntryPage({ params }: { params: Promise<{ locale: Locale; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'gate' });

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-corp text-2xl font-extrabold">{t('chooseTitle')}</h1>
      <div className="rounded-2xl bg-varsity-ivory p-4 text-ink">
        <EmptyState title={t('emptyTitle')} description={t('emptyText')} />
      </div>
      <p className="text-sm">
        {t('organiserHint')}{' '}
        <Link href={`/panel/${orgSlug}/taquilla`} className="font-semibold underline underline-offset-4">
          {t('organiserLink')}
        </Link>
      </p>
    </div>
  );
}
