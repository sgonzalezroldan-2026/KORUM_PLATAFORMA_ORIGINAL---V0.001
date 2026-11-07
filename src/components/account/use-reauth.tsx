'use client';

import { useLocale } from 'next-intl';
import { useCallback, useState } from 'react';
import { accountReauthStatusAction } from '@/app/[locale]/(account)/mi-cuenta/actions';
import { localizedPath } from '@/lib/seo/marketing-routes';
import type { Locale } from '@/i18n/routing';
import { ReauthDialog } from './reauth-dialog';

type Proof = 'email' | 'second-factor';

/**
 * Pide la confirmación de identidad solo cuando hace falta. `ensureFresh(then)` pregunta al servidor si esta sesión se verificó hace menos de 10
 * minutos (sin dejar rastro): si es así, ejecuta `then` al momento; si no, abre el diálogo y lo ejecuta al confirmar. `request(proof, then)`
 * abre el diálogo directamente, para cuando el propio servidor ha respondido que falta la prueba.
 */
export function useReauth(email: string) {
  const locale = useLocale() as Locale;
  const [pending, setPending] = useState<{ proof: Proof; then: () => void } | null>(null);

  const request = useCallback((proof: Proof, then: () => void) => setPending({ proof, then }), []);

  const ensureFresh = useCallback(
    async (then: () => void) => {
      const status = await accountReauthStatusAction();
      if (status.status === 'LOGIN_REQUIRED') window.location.assign(localizedPath(locale, `/login?next=${encodeURIComponent(localizedPath(locale, '/mi-cuenta'))}`));
      else if (status.status === 'FRESH') then();
      else setPending({ proof: 'email', then });
    },
    [locale]
  );

  const dialog = (
    <ReauthDialog
      open={pending !== null}
      email={email}
      proof={pending?.proof ?? 'email'}
      onVerified={() => {
        const then = pending?.then;
        setPending(null);
        then?.();
      }}
      onClose={() => setPending(null)}
    />
  );

  return { ensureFresh, request, dialog };
}
