import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AccountLocaleForm } from '@/components/account/account-locale-form';
import { ChangeEmail } from '@/components/account/change-email';
import { PasskeysPanel } from '@/components/account/passkeys-panel';
import { PrivacyPanel } from '@/components/account/privacy-panel';
import { Link } from '@/i18n/navigation';
import { routing, type Locale } from '@/i18n/routing';
import { requireSession } from '@/lib/auth/guards';
import { getPrisma } from '@/lib/prisma';
import { localizedPath } from '@/lib/seo/marketing-routes';
import { AccountNotFoundError, loadAccountOverview } from '@/repositories/account.repository';
import { emailChangeBlockedUntil } from '@/services/account/email-change-revert.service';
import { EMAIL_CHANGE_CODE_MINUTES, pendingEmailChange } from '@/services/account/email-change.service';

// Depende de la sesión: nunca se guarda en caché ni se comparte entre personas.
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: 'account.privacyAccess' });
  return { title: t('metaTitle'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

const SECTIONS = ['email', 'privacy', 'security', 'language'] as const;

/**
 * *Mi cuenta › Privacidad y acceso* (Sprint 5.10b, `R-52`): lo que no es de diario, separado de las aportaciones, las entradas y los certificados. El email de la cuenta
 * (y cómo cambiarlo), los permisos, la copia de los datos, las solicitudes, la supresión de la cuenta, las llaves de acceso y el idioma de los emails. Todo sale de la
 * sesión (`requireSession`).
 */
export default async function AccountPrivacyPage({ params }: Params) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const session = await requireSession(locale, localizedPath(locale, '/mi-cuenta/privacidad'));
  const t = await getTranslations({ locale, namespace: 'account' });

  let overview;
  try {
    overview = await loadAccountOverview(getPrisma(), session.userId);
  } catch (error) {
    if (error instanceof AccountNotFoundError) notFound();
    throw error;
  }
  const [pending, blockedUntil] = await Promise.all([pendingEmailChange(getPrisma(), session.userId), emailChangeBlockedUntil(getPrisma(), session.userId)]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <Link href="/mi-cuenta" className="inline-flex min-h-11 items-center self-start font-semibold text-varsity-navy underline underline-offset-4">
          {t('privacyAccess.back')}
        </Link>
        <h1 className="font-corp text-3xl font-extrabold text-varsity-navy">{t('privacyAccess.title')}</h1>
        <p className="text-ink-soft">{t('privacyAccess.intro')}</p>
        <nav aria-label={t('privacyAccess.sectionsLabel')}>
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

      <ChangeEmail email={overview.profile.email} twoFactorEnabled={overview.profile.twoFactorEnabled} pending={pending ? { email: pending.email, minutes: EMAIL_CHANGE_CODE_MINUTES } : null} blocked={blockedUntil ? { until: blockedUntil.until.toISOString(), afterRevert: blockedUntil.afterRevert } : null} />
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
