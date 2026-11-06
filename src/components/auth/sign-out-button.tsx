'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { authClient } from '@/lib/auth/auth-client';
import { localizedPath } from '@/lib/seo/marketing-routes';
import type { Locale } from '@/i18n/routing';

/** Cierra la sesión en el servidor (la cookie deja de valer al momento) y vuelve a la portada. */
export function SignOutButton({ className }: { className?: string }) {
  const t = useTranslations('auth');
  const locale = useLocale() as Locale;
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={className ?? 'inline-flex min-h-11 items-center rounded-lg border-2 border-varsity-ivory/60 px-3 font-semibold text-varsity-ivory hover:bg-varsity-ivory/10'}
      onClick={() => {
        setBusy(true);
        void authClient.signOut().finally(() => window.location.assign(localizedPath(locale, '/')));
      }}
    >
      {t('signOut')}
    </button>
  );
}
