'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { authClient } from '@/lib/auth/auth-client';
import { localizedPath } from '@/lib/seo/marketing-routes';
import type { Locale } from '@/i18n/routing';

/**
 * Cierra la sesión en el servidor (la cookie deja de valer al momento) y vuelve a la portada. `data-confirm-leave` hace que una pantalla con cambios sin guardar (los ajustes de la consola)
 * pregunte **antes** de cerrar la sesión: si se cancelara después, la persona se quedaría con el texto sin guardar y sin sesión.
 */
export function SignOutButton({ className }: { className?: string }) {
  const t = useTranslations('auth');
  const locale = useLocale() as Locale;
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      data-confirm-leave="true"
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
