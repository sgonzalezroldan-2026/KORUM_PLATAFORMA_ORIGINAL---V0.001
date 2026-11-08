import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AccountContributions, AccountPasses } from '@/components/account/account-activity';
import { AccountLocaleForm } from '@/components/account/account-locale-form';
import { PasskeysPanel } from '@/components/account/passkeys-panel';
import { PrivacyPanel } from '@/components/account/privacy-panel';
import { SupportTickets } from '@/components/account/support-tickets';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { getEnv } from '@/config/env';
import { signPassView } from '@/core/ticketing/qr-signature';
import { Link } from '@/i18n/navigation';
import { routing, type Locale } from '@/i18n/routing';
import { requireSession } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { helpPath, passPath } from '@/lib/seo/portal-routes';
import { AccountNotFoundError, loadAccountOverview } from '@/repositories/account.repository';
import { countMyIdeas } from '@/services/ideas/my-ideas-data';
import { listSupportTicketsOf } from '@/services/support/support-requests.service';

// Depende de la sesión: nunca se guarda en caché ni se comparte entre personas.
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'account' });
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

const SECTIONS = ['contributions', 'passes', 'documents', 'ideas', 'support', 'privacy', 'security', 'language'] as const;

/**
 * *Mi cuenta* (Sprint 3.7): lo que la persona ha aportado y comprado en todas sus comunidades, sus entradas, sus documentos de donación, sus
 * consentimientos y derechos RGPD, sus llaves de acceso y el idioma de sus emails. Todo sale de la sesión (`requireSession`).
 */
export default async function AccountPage({ params }: Params) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const session = await requireSession(locale, localizedPath(locale, '/mi-cuenta'));
  const t = await getTranslations({ locale, namespace: 'account' });

  let overview;
  try {
    overview = await loadAccountOverview(getPrisma(), session.userId);
  } catch (error) {
    if (error instanceof AccountNotFoundError) notFound();
    throw error;
  }
  const env = getEnv();
  const db = getPrisma();
  const [ideaCounts, owner] = await Promise.all([countMyIdeas(db, session.userId), db.user.findUniqueOrThrow({ where: { id: session.userId }, select: { email: true, emailVerified: true, gdprAnonymizedAt: true } })]);
  const tickets = await listSupportTicketsOf(db, owner);
  // «FAQ y soporte» es de una entidad: la de su última consulta, la de su última aportación o la de su última propuesta o firma.
  const helpSlug = tickets[0]?.organization?.slug ?? overview.contributions[0]?.organization.slug ?? ideaCounts.organizationSlug;
  const qrSecret = env.QR_HMAC_SECRET;
  const passes = overview.passes.map((pass) => ({ ...pass, href: `${passPath(pass.initiative.organization.slug, pass.uuid)}?sig=${signPassView(qrSecret, pass.uuid)}` }));

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('title')}</h1>
          <SignOutButton className="inline-flex min-h-11 items-center rounded-xl border-2 border-varsity-navy px-4 font-semibold text-varsity-navy hover:bg-varsity-navy/10" />
        </div>
        <p className="break-words text-ink-soft">{t('signedInAs', { email: overview.profile.email })}</p>
        <nav aria-label={t('sectionsLabel')}>
          <ul className="flex flex-wrap gap-2">
            {SECTIONS.map((section) => (
              <li key={section}>
                <a href={`#${section}`} className="inline-flex min-h-11 items-center rounded-xl bg-white px-4 font-bold text-varsity-navy shadow-sm hover:bg-varsity-ivory">
                  {t(`sections.${section}`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <AccountContributions contributions={overview.contributions} />
      <AccountPasses passes={passes} />

      <section id="documents" aria-labelledby="documents-title" className="korum-trust-vault flex scroll-mt-4 flex-col gap-3 p-5">
        <h2 id="documents-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('sections.documents')}
        </h2>
        <p className="text-ink-soft">{overview.documentCount > 0 ? t('documents.summary', { count: overview.documentCount }) : t('documents.none')}</p>
        {overview.documentCount > 0 ? (
          <Link href="/mi-cuenta/certificados" className="tactile-btn self-start">
            {t('documents.open')}
          </Link>
        ) : null}
      </section>

      <section id="ideas" aria-labelledby="ideas-title" className="flex scroll-mt-4 flex-col gap-3 rounded-3xl border-2 border-sky-200 bg-sky-50/60 p-5">
        <h2 id="ideas-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
          {t('sections.ideas')}
        </h2>
        <p className="text-ink-soft" data-testid="ideas-summary">
          {ideaCounts.proposals + ideaCounts.signed > 0 ? t('ideas.summary', { proposals: ideaCounts.proposals, signed: ideaCounts.signed }) : t('ideas.none')}
        </p>
        <Link href="/mi-cuenta/propuestas" className="tactile-btn self-start">
          {t('ideas.open')}
        </Link>
      </section>

      <SupportTickets tickets={tickets} helpHref={helpSlug ? localizedPath(locale, helpPath(helpSlug)) : null} />

      <PrivacyPanel
        email={overview.profile.email}
        locale={locale as Locale}
        fingerprintGranted={overview.fingerprintConsent?.granted ?? false}
        requests={overview.privacyRequests.map((request) => ({ ...request, createdAt: request.createdAt.toISOString(), completedAt: request.completedAt?.toISOString() ?? null }))}
        erasureBlock={overview.erasureBlock}
      />
      <PasskeysPanel
        email={overview.profile.email}
        twoFactorEnabled={overview.profile.twoFactorEnabled}
        passkeys={overview.passkeys.map((key) => ({ id: key.id, name: key.name, createdAt: key.createdAt?.toISOString() ?? null, synced: key.backedUp }))}
      />
      <AccountLocaleForm current={overview.profile.locale} />
    </div>
  );
}
