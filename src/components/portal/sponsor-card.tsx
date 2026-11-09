'use client';

import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { SponsorLevel } from '@/core/sponsors/sponsorship-rules';

/**
 * Tarjeta de un comercio amigo (`function renderFamilySponsors` del prototipo; QA-F05). Solo enseña lo público: categoría, nombre, tipo de negocio y
 * la ventaja para las familias. Nunca un importe ni un fee. Si el comercio dejó un código, un diálogo nativo lo muestra grande, con «Copiar» y
 * «Compartir por WhatsApp»; el aviso de copiado va dentro del diálogo, donde un lector de pantalla lo anuncia.
 */

export interface SponsorCardData {
  id: number;
  name: string;
  sector: string;
  level: SponsorLevel;
  promo: string;
  code: string;
  /** Logotipo público del comercio (`/api/files/public/{id}`), si el centro lo ha subido. */
  logoSrc?: string | null;
}

const BADGE: Record<SponsorLevel, { icon: string; className: string }> = {
  ORO: { icon: '🥇', className: 'bg-amber-400 text-slate-950 border-amber-600' },
  PLATA: { icon: '🥈', className: 'bg-slate-200 text-slate-900 border-slate-500' },
  BRONCE: { icon: '🥉', className: 'bg-orange-100 text-amber-950 border-orange-500' }
};

export function SponsorCard({ sponsor, entityName, pageUrl, contentLang }: { sponsor: SponsorCardData; entityName: string; pageUrl: string; contentLang?: string }) {
  const t = useTranslations('portal.sponsors');
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [copied, setCopied] = useState(false);
  const badge = BADGE[sponsor.level];
  const message = sponsor.code ? t('shareMessage', { name: sponsor.name, entity: entityName, code: sponsor.code }) : t('shareMessageNoCode', { name: sponsor.name, entity: entityName });

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(sponsor.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="flex w-full flex-col justify-between gap-3 rounded-3xl border border-patio-rule bg-white p-5 shadow-sm" data-testid="sponsor-card" data-level={sponsor.level}>
      <div className="space-y-2">
        <p className={clsx('inline-flex rounded-full border px-3 py-1 text-xs font-extrabold', badge.className)}>
          <span aria-hidden="true">{`${badge.icon} `}</span>
          {t(`level.${sponsor.level}`)}
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element -- logotipo público servido por /api/files/public, de tamaño pequeño y fijo */}
        {sponsor.logoSrc ? <img src={sponsor.logoSrc} alt="" width={96} height={64} loading="lazy" className="h-16 w-auto max-w-24 object-contain" /> : null}
        {/* Lo que escribe el comercio va en el idioma del contenido de la entidad (WCAG 3.1.2). */}
        <h2 lang={contentLang} className="font-joy text-lg font-bold text-varsity-navy wrap-anywhere">
          <span aria-hidden="true">{'🏪 '}</span>
          {sponsor.name}
        </h2>
        <p lang={sponsor.sector ? contentLang : undefined} className="text-sm text-ink-soft">
          {sponsor.sector || t('sectorFallback')}
        </p>
      </div>
      {sponsor.promo || sponsor.code ? (
        <div className="space-y-2 rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-sm">
          {sponsor.promo ? (
            <p lang={contentLang} className="font-bold text-emerald-950">
              <span aria-hidden="true">{'🎁 '}</span>
              {sponsor.promo}
            </p>
          ) : null}
          {sponsor.code ? (
            <button
              type="button"
              onClick={() => {
                setCopied(false);
                dialog.current?.showModal();
              }}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-varsity-emerald px-4 font-extrabold text-white hover:bg-emerald-800"
            >
              <span aria-hidden="true">{'🎟️ '}</span>
              {t('seeCode')}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="rounded-2xl bg-patio-cream p-3 text-sm text-ink-soft">{t('noPerk')}</p>
      )}
      <a href={`https://wa.me/?text=${encodeURIComponent(`${message} ${pageUrl}`)}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 self-start rounded-xl px-3 font-bold text-ink-soft hover:bg-patio-cream">
        <span aria-hidden="true">{'📤'}</span>
        {t('shareCard')}
      </a>

      {sponsor.code ? (
        <dialog ref={dialog} aria-labelledby={headingId} className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-3xl bg-white p-0 text-ink shadow-2xl backdrop:bg-varsity-navy-deep/70">
          <div className="space-y-4 p-6">
            <div className="flex items-start justify-between gap-3">
              <h3 id={headingId} lang={contentLang} className="font-joy text-lg font-bold text-varsity-navy wrap-anywhere">
                {t('codeTitle', { name: sponsor.name })}
              </h3>
              <button type="button" onClick={() => dialog.current?.close()} aria-label={t('close')} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-xl font-bold text-ink-soft hover:bg-patio-rule">
                <span aria-hidden="true">{'✕'}</span>
              </button>
            </div>
            {sponsor.promo ? <p lang={contentLang} className="font-bold text-emerald-950">{sponsor.promo}</p> : null}
            <p className="rounded-xl border-2 border-dashed border-emerald-700 bg-emerald-50 p-3 text-center font-mono text-2xl font-extrabold tracking-wider text-emerald-950" data-testid="sponsor-code">
              {sponsor.code}
            </p>
            <div className="grid gap-2">
              <button type="button" onClick={copyCode} className="min-h-11 rounded-xl bg-varsity-navy px-4 font-extrabold text-white hover:bg-varsity-navy-deep">
                <span aria-hidden="true">{'📋 '}</span>
                {t('copy')}
              </button>
              <a href={`https://wa.me/?text=${encodeURIComponent(`${message} ${pageUrl}`)}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-700 px-4 font-extrabold text-white hover:bg-emerald-800">
                <span aria-hidden="true">{'📤 '}</span>
                {t('shareWhatsapp')}
              </a>
            </div>
            <p role="status" className="min-h-6 text-center text-sm font-bold text-emerald-900">
              {copied ? t('copied') : ''}
            </p>
          </div>
        </dialog>
      ) : null}
    </article>
  );
}
