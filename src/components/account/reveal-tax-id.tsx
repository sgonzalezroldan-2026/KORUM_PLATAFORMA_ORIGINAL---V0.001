'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { secondaryButton } from '@/components/auth/auth-ui';
import { useReauth } from './use-reauth';

/**
 * El NIF del certificado sale oculto salvo que la sesión haya confirmado la identidad en los últimos 10 minutos (auditoría del 3.7, I4): una
 * sesión abierta en el ordenador de casa no basta para ver el NIF completo. Al confirmar con el código, la página se vuelve a pedir y lo enseña.
 */
export function RevealTaxId({ email }: { email: string }) {
  const t = useTranslations('account.documents');
  const router = useRouter();
  const { ensureFresh, dialog } = useReauth(email);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 rounded-2xl border-2 border-varsity-navy/15 bg-white p-4 print:hidden">
      <p className="text-ink-soft">{t('maskedTaxId')}</p>
      <button type="button" className={`${secondaryButton} sm:w-auto sm:self-start`} onClick={() => void ensureFresh(() => router.refresh())}>
        {t('revealTaxId')}
      </button>
      {dialog}
    </div>
  );
}
