import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ClearCheckoutDraft, Confetti, PendingRefresh, RisingProgress } from '@/components/checkout/checkout-celebration';
import { SponsorshipResult } from '@/components/checkout/sponsorship-result';
import { ShareButton } from '@/components/portal/share-button';
import { EmptyState } from '@/components/ui/empty-state';
import { getEnv } from '@/config/env';
import { checkoutOutcome, verifyCheckoutResult } from '@/core/checkout/checkout-rules';
import { formatCents } from '@/core/finance/money';
import { percentOf } from '@/core/public/catalog';
import { groupSlug, orderedGroupNames } from '@/core/public/course-challenge';
import { localizeRow } from '@/core/public/view-model';
import { signPassView } from '@/core/ticketing/qr-signature';
import { Link } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { getPrisma } from '@/lib/prisma';
import { absoluteUrl } from '@/lib/seo/marketing-routes';
import { checkoutPath, INITIATIVE_ID_PATTERN, initiativePath, passPath } from '@/lib/seo/portal-routes';
import { getCheckoutResult } from '@/repositories/checkout.repository';
import { getSponsorshipResult } from '@/repositories/sponsorship.repository';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: isLocale(locale) ? locale : 'es', namespace: 'portal.result' });
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

interface PageProps {
  params: Promise<{ locale: string; orgSlug: string; id: string }>;
  searchParams: Promise<{ pedido?: string | string[]; sig?: string | string[] }>;
}

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));
const linkClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-center font-extrabold';

/**
 * Vuelta del pago (QA-F10): celebración con el nuevo avance y la opción de compartir, espera de la confirmación o explicación del rechazo en
 * lenguaje llano con «Probar otra vez» y el otro método sin perder lo elegido. El estado sale **solo** de lo que guardó el webhook firmado; el
 * enlace lleva su propia firma (solo lo recibe quien pagó) y no se indexa ni se envía en el `Referer`.
 */
export default async function CheckoutResultPage({ params, searchParams }: PageProps) {
  const { locale, orgSlug, id } = await params;
  if (!isLocale(locale) || !INITIATIVE_ID_PATTERN.test(id)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'portal.result' });
  const query = await searchParams;
  const order = first(query.pedido);
  const env = getEnv();
  const initiativeId = Number(id);

  const signature = first(query.sig);
  const verified = verifyCheckoutResult(env.DATA_HMAC_SECRET, order, signature);
  const row = verified ? await getCheckoutResult(getPrisma(), orgSlug, initiativeId, order) : null;
  if (!row && verified) {
    // Un pedido `KS…` es de un comercio: tiene su propia vuelta (documentos, revisión del centro).
    const sponsorship = await getSponsorshipResult(getPrisma(), orgSlug, initiativeId, order);
    if (sponsorship) return <SponsorshipResult row={sponsorship} orgSlug={orgSlug} initiativeId={initiativeId} locale={locale} order={order} signature={signature} />;
  }
  if (!row) return <EmptyState icon="🧾" title={t('invalid.title')} description={t('invalid.description')} headingLevel={1} role="alert" action={<Link href={initiativePath(orgSlug, initiativeId)} className={`${linkClass} bg-varsity-navy text-white`}>{t('back')}</Link>} />;

  const { initiative } = row;
  const title = localizeRow({ title: initiative.title, description: '', translationsJson: initiative.translationsJson }, locale, initiative.organization.contentLocale).row.title;
  const outcome = checkoutOutcome(row.status, row.createdAt, new Date());
  const method = row.paymentMethod === 'BIZUM' ? 'BIZUM' : 'CARD';
  const otherMethod = method === 'BIZUM' ? 'CARD' : 'BIZUM';
  const back = <Link href={initiativePath(orgSlug, initiativeId)} className={`${linkClass} border-2 border-patio-rule-strong bg-white text-varsity-navy`}>{t('back')}</Link>;

  if (outcome === 'FAILED' || outcome === 'UNCONFIRMED') {
    // Lo elegido viaja también en la URL (sin email ni NIF): si al volver de Bizum se abre otra pestaña, no se pierde.
    const hint = new URLSearchParams({ reintento: '1' });
    if (row.type === 'DONATION') {
      hint.set('importe', String(row.amountCents));
      hint.set('aportacion', String(row.guaranteeContributionCents));
    } else if (row.ticketQuantity) hint.set('cantidad', String(row.ticketQuantity));
    if (row.groupName) hint.set('grupo', groupSlug(row.groupName));
    const retry = `${checkoutPath(orgSlug, initiativeId)}?${hint.toString()}`;
    return (
      <section className="korum-trust-vault mx-auto max-w-lg space-y-4 p-6 text-center" aria-labelledby="result-title">
        <h1 id="result-title" className="font-joy text-2xl font-bold text-varsity-navy">
          {outcome === 'FAILED' ? t(`failed.title.${method}`) : t('unconfirmed.title')}
        </h1>
        <p role="alert" className="font-semibold text-ink">
          {outcome === 'FAILED' ? t('failed.description') : t('unconfirmed.description')}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Link href={`${retry}&metodo=${method}`} className={`${linkClass} bg-varsity-emerald text-white`}>{t('failed.retry')}</Link>
          <Link href={`${retry}&metodo=${otherMethod}`} className={`${linkClass} bg-varsity-navy text-white`}>{t(`failed.switchTo.${otherMethod}`)}</Link>
        </div>
        {back}
      </section>
    );
  }

  if (outcome === 'PENDING' || outcome === 'RETURNED') {
    return (
      <section className="korum-trust-vault mx-auto max-w-lg space-y-4 p-6 text-center" aria-labelledby="result-title">
        <h1 id="result-title" className="font-joy text-2xl font-bold text-varsity-navy">
          {outcome === 'PENDING' ? t('pending.title') : t('returned.title')}
        </h1>
        <p role="status" className="text-ink">
          {outcome === 'PENDING' ? t('pending.description') : t('returned.description')}
        </p>
        {outcome === 'PENDING' ? <PendingRefresh /> : null}
        {back}
      </section>
    );
  }

  const ticketing = row.type === 'TICKET';
  const subtype = row.ticketPass?.subtype === 'RAFFLE' ? 'RAFFLE' : 'EVENT';
  const toPct = ticketing ? percentOf(initiative.ticketsSold, initiative.ticketMax ?? 0) : percentOf(initiative.raisedCents, initiative.goalCents);
  const fromPct = ticketing ? percentOf(initiative.ticketsSold - (row.ticketQuantity ?? 0), initiative.ticketMax ?? 0) : percentOf(initiative.raisedCents - row.amountCents, initiative.goalCents);
  const course = row.groupName && initiative.rewardEnabled ? initiative.courses.find((entry) => entry.groupName === row.groupName) : undefined;
  const pass = row.ticketPass && !row.ticketPass.revokedAt ? row.ticketPass : null;
  const shareGroups = initiative.rewardEnabled ? orderedGroupNames(initiative.organization.vertical, initiative.organization.participationGroupsJson).map((name) => ({ slug: groupSlug(name), name })) : [];
  const reached = toPct >= 100;

  return (
    <section className="korum-trust-vault mx-auto max-w-lg space-y-5 p-6 text-center" aria-labelledby="result-title" data-testid="checkout-celebration">
      <ClearCheckoutDraft initiativeId={initiativeId} />
      {reached ? <Confetti /> : null}
      <h1 id="result-title" className="font-joy text-2xl font-bold text-varsity-navy">
        <span aria-hidden="true">{ticketing ? '🎟️ ' : '💛 '}</span>
        {ticketing ? t(`confirmed.titleTickets.${subtype}`) : t('confirmed.title')}
      </h1>
      <p lang={initiative.organization.contentLocale === locale ? undefined : initiative.organization.contentLocale} className="font-corp text-lg font-extrabold text-varsity-navy wrap-anywhere">
        {title}
      </p>
      <p className="font-corp font-bold tabular-nums text-ink">{t('confirmed.paid', { total: formatCents(row.totalChargedCents, locale) })}</p>
      <div className="space-y-2">
        <RisingProgress fromPct={fromPct} toPct={toPct} label={t('confirmed.progressLabel', { title })} />
        <p className="font-corp text-sm font-bold tabular-nums text-ink-soft">{t('confirmed.pct', { pct: toPct })}</p>
        <p role="status" className="font-joy text-lg font-bold text-emerald-900">
          <span aria-hidden="true">{reached ? '🎉 ' : '💛 '}</span>
          {reached ? (ticketing ? t('confirmed.soldOut') : t('confirmed.goalReached')) : t('confirmed.count', { count: initiative.totalContributions })}
        </p>
      </div>
      {course ? <p className="die-cut-sticker mx-auto inline-flex text-sm">{t('confirmed.group', { group: course.groupName, count: course.familiesCount, target: initiative.targetFamiliesPerCourse })}</p> : null}
      {pass ? (
        <div className="space-y-2 rounded-2xl border border-sky-300 bg-sky-50 p-4">
          <p className="font-mono text-sm text-ink-soft">{t('confirmed.serial', { serial: pass.serialCode })}</p>
          <Link href={`${passPath(orgSlug, pass.uuid)}?sig=${signPassView(env.QR_HMAC_SECRET, pass.uuid)}`} className={`${linkClass} w-full bg-sky-800 text-white`} data-testid="view-pass">
            <span aria-hidden="true">{'🎟️ '}</span>
            {t(`confirmed.viewPass.${subtype}`)}
          </Link>
          <p className="text-sm text-ink-soft">{t('confirmed.ticketsEmail')}</p>
        </div>
      ) : (
        <p className="text-sm text-ink-soft">{t('confirmed.receipt')}</p>
      )}
      <div className="space-y-2 rounded-2xl bg-patio-cream p-4">
        <p className="font-semibold text-ink">{t('confirmed.share')}</p>
        <div className="flex justify-center">
          <ShareButton target={{ title, entityName: initiative.organization.name, url: absoluteUrl(locale, initiativePath(orgSlug, initiativeId)), groups: shareGroups }} />
        </div>
      </div>
      {back}
    </section>
  );
}
