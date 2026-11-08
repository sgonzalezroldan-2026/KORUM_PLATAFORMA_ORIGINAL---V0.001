import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { IdeaChat } from '@/components/account/idea-chat';
import { MySignatures } from '@/components/account/my-signatures';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { requireSession } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { loadMyIdeas } from '@/services/ideas/my-ideas-data';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'account.proposals' });
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/**
 * «Mis propuestas y mensajes con el centro» y «Mis firmas» (Sprint 3.9; en el prototipo, dentro de Mi Hucha). El chat es anónimo: el centro solo ve
 * el código `#FAM-XXXX`. Todo sale de la sesión; las ideas de otras personas no se pueden pedir.
 */
export default async function ProposalsPage({ params }: Params) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const session = await requireSession(locale, localizedPath(locale, '/mi-cuenta/propuestas'));
  const t = await getTranslations({ locale, namespace: 'account.proposals' });
  const { proposals, signed } = await loadMyIdeas(getPrisma(), session.userId);

  return (
    <div className="flex flex-col gap-8">
      <Link href="/mi-cuenta" className="inline-flex min-h-11 items-center gap-1 self-start font-semibold text-varsity-navy underline underline-offset-4">
        <span aria-hidden="true">{'← '}</span>
        {t('back')}
      </Link>
      <header className="flex flex-col gap-2">
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
        <p className="text-ink-soft">{t('intro')}</p>
      </header>

      <section id="proposals" aria-labelledby="proposals-title" className="flex scroll-mt-4 flex-col gap-3">
        <h2 id="proposals-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('proposalsTitle')}
        </h2>
        {proposals.length === 0 ? (
          <EmptyState icon="💡" title={t('empty.title')} description={t('empty.description')} playful action={<Link href="/" className="tactile-btn">{t('empty.action')}</Link>} />
        ) : (
          proposals.map((proposal) => <IdeaChat key={proposal.id} proposal={proposal} />)
        )}
      </section>

      <MySignatures signed={signed} />
    </div>
  );
}
