'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Field } from '@/components/auth/auth-ui';
import { KorumMark } from '@/components/brand/korum-mark';
import { POSTER_LIMITS } from '@/core/studio/poster-rules';

/**
 * Configurador del cartel A4 con QR (`poster-modal`, `updatePosterPreview`, `printable-poster` del prototipo). La entidad cambia el título y el mensaje y
 * ve el cartel en la misma página; «Imprimir» saca solo la hoja (el resto lleva `print:hidden`). El QR es **real**: lleva a la ficha pública de la campaña
 * y se genera en el servidor, y debajo va la dirección escrita para quien no pueda escanear. Sin importes, sin nombres de personas y sin «Escrow» (Regla 03 §4).
 */

export interface PosterConfiguratorProps {
  logoSrc: string | null;
  walletId: string;
  /** QR vectorial, ya generado en el servidor. */
  qrSvg: string;
  /** El mismo QR en PNG de alta resolución, para descargarlo solo. */
  qrPng: string;
  /** Dirección a la que lleva el QR, sin `https://`. */
  displayUrl: string;
  defaultTitle: string;
  defaultMessage: string;
  /** Idioma en que escribe la entidad: la hoja impresa va en él (la de sus familias), aunque quien la prepara use otro. */
  contentLang: string;
  /** Textos fijos de la hoja, ya traducidos a ese idioma. */
  sheet: { label: string; platform: string; payments: string; withKorum: string; qrLabel: string; guarantee: string };
}

export function PosterConfigurator({ logoSrc, walletId, qrSvg, qrPng, displayUrl, defaultTitle, defaultMessage, contentLang, sheet }: PosterConfiguratorProps) {
  const t = useTranslations('panel.studio.poster');
  const [title, setTitle] = useState(defaultTitle);
  const [message, setMessage] = useState(defaultMessage);

  return (
    <div className="flex flex-col gap-5">
      <div className="mobile-stack korum-trust-vault grid gap-4 p-4 print:hidden sm:grid-cols-2">
        <Field label={t('customTitle')} value={title} maxLength={POSTER_LIMITS.titleMax} onChange={(event) => setTitle(event.target.value)} />
        <Field label={t('customMessage')} value={message} maxLength={POSTER_LIMITS.messageMax} onChange={(event) => setMessage(event.target.value)} />
      </div>

      <div className="flex flex-wrap gap-3 print:hidden">
        <button type="button" onClick={() => window.print()} className="tactile-btn" data-testid="poster-print">
          <span aria-hidden="true">{'🖨️ '}</span>
          {t('print')}
        </button>
        <a href={qrPng} download={`korum-qr-${walletId}.png`} className="inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-varsity-navy px-4 font-semibold text-varsity-navy hover:bg-varsity-navy/10" data-testid="poster-download-qr">
          <span aria-hidden="true">{'📱 '}</span>
          {t('downloadQr')}
        </a>
      </div>

      <section lang={contentLang} aria-label={sheet.label} className="korum-poster-sheet mx-auto flex w-full max-w-[210mm] flex-col items-center gap-4 rounded-3xl border-4 border-varsity-navy bg-white p-6 text-center break-inside-avoid sm:p-10 print:max-h-[277mm] print:gap-3 print:overflow-hidden print:p-6" data-testid="poster-sheet">
        <div className="flex w-full items-center justify-between gap-3 border-b-2 border-varsity-navy pb-3">
          <span className="inline-flex items-center gap-2 font-corp text-sm font-extrabold uppercase tracking-wider text-varsity-navy">
            <KorumMark size={28} />
            {sheet.platform}
          </span>
          <span className="rounded-full border border-emerald-300 bg-emerald-100 px-2.5 py-0.5 text-xs font-extrabold uppercase text-emerald-900">{sheet.payments}</span>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- imagen pública servida por /api/files/public, sin optimizador al imprimir */}
        {logoSrc ? <img src={logoSrc} alt="" className="max-h-24 w-auto object-contain print:max-h-20" data-testid="poster-logo" /> : null}
        <p className="font-corp text-sm font-extrabold uppercase text-varsity-navy wrap-anywhere">{sheet.withKorum}</p>
        <h2 className="font-joy text-3xl font-bold text-varsity-navy wrap-anywhere sm:text-5xl print:text-4xl" data-testid="poster-title">
          {title}
        </h2>
        <p className="max-w-xl text-base text-ink-soft wrap-anywhere sm:text-xl print:text-lg" data-testid="poster-message">
          {message}
        </p>
        <div className="rounded-2xl border-2 border-varsity-navy bg-white p-3">
          <div aria-label={sheet.qrLabel} role="img" className="size-44 sm:size-64 print:size-56 [&>svg]:size-full" data-testid="poster-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        </div>
        {/* Alternativa al QR, impresa: quien no puede escanear lo teclea. */}
        <p className="break-all font-corp text-base font-extrabold text-varsity-navy" data-testid="poster-url">
          {displayUrl}
        </p>
        <p className="max-w-xl text-sm font-bold text-emerald-900">
          <span aria-hidden="true">{'🔒 '}</span>
          {sheet.guarantee}
        </p>
      </section>
    </div>
  );
}
