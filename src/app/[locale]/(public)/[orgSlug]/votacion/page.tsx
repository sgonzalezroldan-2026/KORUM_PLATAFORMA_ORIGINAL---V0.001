import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ResizeBallotForm } from '@/components/portal/resize-ballot-form';
import { ResizeLinkResendForm } from '@/components/portal/resize-link-resend-form';
import { EmptyState } from '@/components/ui/empty-state';
import { getEnv } from '@/config/env';
import { formatCents } from '@/core/finance/money';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { portalPath } from '@/lib/seo/portal-routes';
import { loadResizeBallot } from '@/services/resize/resize-vote.service';

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string }>;
  searchParams: Promise<{ v?: string | string[] }>;
}

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));

/** Depende del enlace de cada persona: nunca se genera ni se guarda en caché. */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: isLocale(locale) ? locale : 'es', namespace: 'portal.resizeVote' });
  // El enlace es personal (vota por una persona): ni se indexa ni viaja en el `Referer`.
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/**
 * Votación de redimensionamiento de una campaña que no llegó a su meta (Sprint 4.4b, prototipo `sendResizePollToDonors`): con `?v=` (el enlace del email)
 * enseña la papeleta, el voto ya emitido o el resultado. Una persona, un voto; «Prefiero que me devolváis mi aportación» siempre está y se cumple sí o sí.
 */
export default async function ResizeVotePage({ params, searchParams }: PageProps) {
  const { locale, orgSlug } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const [t, format, search] = await Promise.all([getTranslations({ locale, namespace: 'portal.resizeVote' }), getFormatter({ locale }), searchParams]);
  const token = first(search.v);
  const ballot = await loadResizeBallot(getPrisma(), getEnv().DATA_HMAC_SECRET, orgSlug, token);
  const back = (
    <Link href={portalPath(orgSlug)} className="tactile-btn">
      {t('backToPortal')}
    </Link>
  );
  if (ballot.status === 'INVALID') {
    // Sin enlace (o con uno que no sirve): se puede pedir el propio otra vez con el email con el que se donó (Sprint 5.5b). Sin enlace no es un error.
    return (
      <div className="mobile-stack mx-auto flex max-w-xl flex-col gap-6 px-4 py-8">
        <EmptyState icon="🗳️" title={t(token ? 'invalid.title' : 'noLink.title')} description={t(token ? 'invalid.description' : 'noLink.description')} headingLevel={1} role={token ? 'alert' : undefined} action={back} />
        <ResizeLinkResendForm orgSlug={orgSlug} />
      </div>
    );
  }

  const date = format.dateTime(ballot.closesAt, { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Madrid' });
  const percent = ballot.originalGoalCents > 0 ? Math.floor((ballot.raisedCents * 100) / ballot.originalGoalCents) : 0;

  if (ballot.vote) {
    const voted = ballot.vote.kind === 'REFUND' ? `${t('voted.refund')} ${t('voted.refundNotice')}` : t('voted.option', { option: ballot.options[ballot.vote.index] ?? '' });
    // Con la votación cerrada, también el resultado; abierta, cuándo se cierra (solo a quien sigue en la campaña: quien pidió su devolución no recibe el resultado).
    const next = ballot.status === 'CLOSED' ? (ballot.winner ? t('closed.won', { option: ballot.winner }) : t('closed.refund')) : ballot.vote.kind === 'OPTION' ? t('voted.until', { date }) : '';
    return <EmptyState icon={ballot.vote.kind === 'REFUND' ? '↩️' : '🗳️'} title={t('voted.title')} description={`${voted} ${next}`.trim()} headingLevel={1} playful={ballot.vote.kind === 'OPTION'} action={back} />;
  }
  if (ballot.status === 'CLOSED') {
    return <EmptyState icon="⏳" title={t('closed.title')} description={ballot.winner ? t('closed.won', { option: ballot.winner }) : t('closed.refund')} headingLevel={1} action={back} />;
  }
  if (ballot.refundableCents === 0) return <EmptyState icon="🧾" title={t('noDonation.title')} description={t('noDonation.description')} headingLevel={1} role="alert" action={back} />;

  return (
    <section className="mobile-stack mx-auto flex max-w-xl flex-col gap-4 px-4 py-8" aria-labelledby="resize-vote-title">
      <header className="flex flex-col gap-2">
        <h1 id="resize-vote-title" className="font-joy text-3xl font-bold wrap-anywhere text-varsity-navy">
          {t('title', { initiative: ballot.title })}
        </h1>
        <p className="text-ink-soft">{t('intro', { organization: ballot.organizationName, raised: formatCents(ballot.raisedCents, locale), goal: formatCents(ballot.originalGoalCents, locale), percent })}</p>
      </header>
      <ul className="korum-notebook-sheet flex list-disc flex-col gap-1 rounded-2xl p-4 ps-16 text-sm text-varsity-navy">
        <li>{t('rules.oneVote')}</li>
        <li>{t('rules.refund')}</li>
        <li>{t('rules.result')}</li>
        <li>{t('rules.until', { date })}</li>
      </ul>
      <ResizeBallotForm orgSlug={orgSlug} token={token} options={ballot.options} refundLabel={t('refundAmount')} />
      <p className="font-corp text-sm tabular-nums text-ink-soft">{t('legal', { wallet: ballot.walletEscrowId })}</p>
    </section>
  );
}
