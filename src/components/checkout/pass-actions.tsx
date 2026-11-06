'use client';

import { useTranslations } from 'next-intl';

/**
 * Acciones del pase (skill de taquilla §4): imprimir con una hoja limpia (`@media print` oculta todo lo demás) y enviarlo por WhatsApp, con el
 * aviso de que quien tenga el enlace puede usar la entrada. No salen al imprimir.
 */
export function PassActions({ title, url }: { title: string; url: string }) {
  const t = useTranslations('portal.pass');
  const message = t('shareMessage', { title, url });
  const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 font-extrabold';

  return (
    <div role="group" aria-label={t('actions')} className="space-y-2 print:hidden">
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => window.print()} className={`${buttonClass} bg-varsity-navy text-white`}>
          <span aria-hidden="true">{'🖨️'}</span>
          {t('print')}
        </button>
        <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer" className={`${buttonClass} bg-[#0f7a40] text-white`}>
          <span aria-hidden="true">{'📲'}</span>
          {t('shareWhatsapp')}
        </a>
      </div>
      <p className="text-sm text-ink-soft">{t('shareWarning')}</p>
    </div>
  );
}
