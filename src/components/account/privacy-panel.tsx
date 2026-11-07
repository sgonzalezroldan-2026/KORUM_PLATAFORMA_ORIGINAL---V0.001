'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { withdrawFingerprintFromAccountAction } from '@/app/[locale]/(account)/mi-cuenta/actions';
import { FormAlert, secondaryButton } from '@/components/auth/auth-ui';
import type { Locale } from '@/i18n/routing';
import { EraseAccount, type ErasureBlockReason } from './erase-account';
import { useReauth } from './use-reauth';

/**
 * Privacidad en *Mi cuenta* (Sprint 3.7, QA-PRIV01 y QA-PRIV02): el permiso de la huella del navegador (se retira con un clic, igual que se dio),
 * la descarga de los datos en JSON y PDF (tras confirmar la identidad con un código) y el historial de solicitudes. La supresión de la cuenta
 * va en su propio bloque (`EraseAccount`).
 */

export interface PrivacyRequestRow {
  id: number;
  type: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

type Format = 'json' | 'pdf';
type ExportState = { tone: 'success' | 'error'; key: 'downloaded' | 'rateLimited' | 'failed' } | null;

export function PrivacyPanel({ email, locale, fingerprintGranted, requests, erasureBlock }: { email: string; locale: Locale; fingerprintGranted: boolean; requests: PrivacyRequestRow[]; erasureBlock: ErasureBlockReason | null }) {
  const t = useTranslations('account.privacy');
  const format = useFormatter();
  const router = useRouter();
  const { ensureFresh, request, dialog } = useReauth(email);
  const [withdrawn, setWithdrawn] = useState(false);
  const [withdrawing, startWithdraw] = useTransition();
  const [downloading, setDownloading] = useState<Format | null>(null);
  const [exportState, setExportState] = useState<ExportState>(null);

  const withdraw = () =>
    startWithdraw(async () => {
      const result = await withdrawFingerprintFromAccountAction();
      if (result.status === 'WITHDRAWN') {
        setWithdrawn(true);
        router.refresh();
      }
    });

  async function download(kind: Format) {
    setDownloading(kind);
    setExportState(null);
    try {
      const response = await fetch('/api/cuenta/exportar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: kind, locale }) });
      if (response.status === 403) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'REAUTH_REQUIRED') return request('email', () => void download(kind));
        return setExportState({ tone: 'error', key: 'failed' });
      }
      if (response.status === 429) return setExportState({ tone: 'error', key: 'rateLimited' });
      if (!response.ok) return setExportState({ tone: 'error', key: 'failed' });
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `korum-mis-datos.${kind}`;
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setExportState({ tone: 'success', key: 'downloaded' });
      router.refresh();
    } catch {
      setExportState({ tone: 'error', key: 'failed' });
    } finally {
      setDownloading(null);
    }
  }

  const granted = fingerprintGranted && !withdrawn;
  // Tras retirar el permiso el botón desaparece: el foco pasa al aviso del estado y no cae al principio de la página (WCAG 2.4.3).
  const consentStatus = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (withdrawn) consentStatus.current?.focus();
  }, [withdrawn]);

  return (
    <section id="privacy" aria-labelledby="privacy-title" className="korum-trust-vault flex scroll-mt-4 flex-col gap-6 p-5">
      <h2 id="privacy-title" className="font-corp text-2xl font-extrabold text-varsity-navy">
        {t('title')}
      </h2>

      <div className="flex flex-col gap-3">
        <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('consents.title')}</h3>
        <p className="text-ink-soft">{t('consents.fingerprintText')}</p>
        <p ref={consentStatus} tabIndex={-1} className="font-semibold text-varsity-navy" role="status">
          {granted ? t('consents.granted') : withdrawn ? t('consents.withdrawn') : t('consents.notGranted')}
        </p>
        {granted ? (
          <button type="button" className={`${secondaryButton} sm:w-auto sm:self-start`} disabled={withdrawing} onClick={withdraw}>
            {t('consents.withdraw')}
          </button>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('export.title')}</h3>
        <p className="text-ink-soft">{t('export.text')}</p>
        <div className="mobile-stack grid gap-3 md:grid-cols-2">
          {(['json', 'pdf'] as const).map((kind) => (
            // `aria-disabled` y no `disabled`: un botón deshabilitado pierde el foco y quien usa teclado volvería al principio de la página.
            <button
              key={kind}
              type="button"
              className={`${secondaryButton} aria-disabled:cursor-wait aria-disabled:opacity-60`}
              aria-disabled={downloading !== null}
              onClick={() => {
                if (downloading === null) void ensureFresh(() => void download(kind));
              }}
              data-testid={`export-${kind}`}
            >
              {downloading === kind ? t('export.preparing') : t(`export.${kind}`)}
            </button>
          ))}
        </div>
        {exportState ? <FormAlert tone={exportState.tone}>{t(`export.${exportState.key}`)}</FormAlert> : null}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="font-corp text-lg font-extrabold text-varsity-navy">{t('requests.title')}</h3>
        {requests.length === 0 ? (
          <p className="text-ink-soft">{t('requests.none')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {requests.map((row) => (
              <li key={row.id} className="rounded-xl bg-white px-3 py-2 text-sm">
                <span className="font-bold text-varsity-navy">{t(`requests.type.${row.type}`)}</span>
                {' · '}
                {format.dateTime(new Date(row.createdAt), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' })}
                {' · '}
                <span className="font-semibold">{t(`requests.status.${row.status}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <EraseAccount block={erasureBlock} ensureFresh={ensureFresh} request={request} />
      {dialog}
    </section>
  );
}
