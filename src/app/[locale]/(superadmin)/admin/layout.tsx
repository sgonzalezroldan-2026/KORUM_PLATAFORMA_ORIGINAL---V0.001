import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { PricingBadge } from '@/components/admin/pricing-badge';
import { ConsoleHeader } from '@/components/panel/console-header';
import { routing } from '@/i18n/routing';
import { requireSuperadminAccess } from '@/lib/auth/guards';
import { getPricingHealthForRequest } from '@/lib/console-pricing';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Entorno 3 · consola del Super-Admin: sin sesión a `/login`, sin rol 403, sin segundo factor en esta sesión a activarlo. */
export default async function AdminLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const { session } = await requireSuperadminAccess(locale);
  const t = await getTranslations({ locale, namespace: 'admin' });
  const pricing = await getPricingHealthForRequest();
  return (
    <div className="flex min-h-dvh flex-col">
      <ConsoleHeader title={t('headerTitle')} subtitle={session.email} badge={<PricingBadge open={pricing.open} openCritical={pricing.openCritical} />} />
      <main id="contenido" className="flex-1 bg-varsity-ivory">
        {children}
      </main>
    </div>
  );
}
