'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { isLocale } from '@/i18n/routing';
import { formatCents } from '@/core/finance/money';
import { isKitAvailable, medalHashtags, whatsappShareUrl, type MedalLevel } from '@/core/medals/medal-kit';

/**
 * Medallas y kit de la entidad (Sprint 4.1, `renderSchoolMedalsExplainer` y `openMedalKitModal`): los tres niveles con su beca exenta y, para los
 * que la entidad ya tiene, el kit: informe de impacto (PDF), sello para la web (SVG) y un texto para sus redes que puede editar, copiar o
 * compartir por WhatsApp. Un nivel por conseguir no tiene kit: se explica cuánto falta, en positivo.
 */

export interface MedalKitProps {
  orgSlug: string;
  entityName: string;
  vertical: 'SCHOOL' | 'SPORTS_CLUB' | 'CULTURAL';
  period: string;
  levels: MedalLevel[];
}

const linkButton = 'tactile-btn w-full justify-center text-center';

export function MedalKit({ orgSlug, entityName, vertical, period, levels }: MedalKitProps) {
  const t = useTranslations('panel.medals');
  const locale = useLocale();
  const money = (cents: number) => formatCents(cents, isLocale(locale) ? locale : 'es');
  /** El nombre del nivel en el idioma de la persona; si la consola trae un nivel nuevo sin traducir, el de la consola. */
  const nameOf = (level: MedalLevel) => (t.has(`names.${level.key}`) ? t(`names.${level.key}`) : level.name);
  const headingId = useId();
  const textId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<MedalLevel | null>(null);
  const [post, setPost] = useState('');
  /** Resultado de «Copiar»: se dice dentro del diálogo, porque un diálogo modal deja fuera de la vista (y de los lectores de pantalla) cualquier aviso global. */
  const [copyResult, setCopyResult] = useState<'copied' | 'manual' | null>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (selected && !node.open) node.showModal();
    if (!selected && node.open) node.close();
  }, [selected]);

  const open = (level: MedalLevel) => {
    setCopyResult(null);
    setPost(t(`post.${vertical}`, { entity: entityName, tier: nameOf(level), icon: level.icon, hashtags: medalHashtags(entityName) }));
    setSelected(level);
  };

  const download = (level: MedalLevel, kind: 'informe' | 'sello') => `/api/panel/medalla?${new URLSearchParams({ orgSlug, nivel: level.key, tipo: kind, locale }).toString()}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(post);
      setCopyResult('copied');
    } catch {
      document.getElementById(textId)?.focus();
      (document.getElementById(textId) as HTMLTextAreaElement | null)?.select();
      setCopyResult('manual');
    }
  }

  return (
    <section aria-labelledby={`${headingId}-title`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={`${headingId}-title`} className="font-joy text-lg font-bold text-varsity-navy">
          {t('title')}
        </h2>
        <p className="text-sm text-ink-soft">{t('intro')}</p>
      </div>

      <ul className="mobile-stack grid gap-3 md:grid-cols-3">
        {levels.map((level) => (
          <li key={level.key} className={`flex flex-col gap-2 rounded-2xl border-2 bg-white p-4 ${level.state === 'EARNED' ? 'border-amber-500' : 'border-varsity-navy/15'}`}>
            <p className="font-corp font-extrabold text-varsity-navy">
              <span aria-hidden="true">{`${level.icon} `}</span>
              {t('level', { name: nameOf(level) })}
            </p>
            <p className="text-sm font-bold text-varsity-emerald">{t('grantLine', { amount: money(level.grantCents) })}</p>
            <p className="text-sm text-ink-soft">
              {level.state === 'EARNED' ? t('state.EARNED') : level.state === 'NEXT' ? t('state.NEXT', { missing: level.campaignsMissing, required: level.campaignsRequired }) : t('state.LOCKED', { required: level.campaignsRequired })}
            </p>
            {isKitAvailable(level) ? (
              <button type="button" className="tactile-btn mt-auto w-full justify-center" onClick={() => open(level)}>
                <span aria-hidden="true">{'🏅 '}</span>
                {t('kit.open')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      <dialog
        ref={dialog}
        aria-labelledby={`${headingId}-dialog`}
        onClose={() => setSelected(null)}
        className="m-auto w-[min(100%-2rem,34rem)] rounded-3xl border-2 border-varsity-navy bg-white p-0 text-ink backdrop:bg-varsity-navy/60"
      >
        {selected ? (
          <div className="flex flex-col gap-4 p-6">
            <h2 id={`${headingId}-dialog`} className="font-corp text-xl font-extrabold text-varsity-navy">
              {t('kit.title', { name: nameOf(selected) })}
            </h2>
            <div className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 text-center">
              <p aria-hidden="true" className="text-4xl">
                {selected.icon}
              </p>
              <p className="font-joy text-base font-bold text-varsity-navy">{t('kit.badge', { name: nameOf(selected), period })}</p>
            </div>
            <div className="mobile-stack grid gap-2 sm:grid-cols-2">
              <a className={linkButton} href={download(selected, 'informe')} download>
                <span aria-hidden="true">{'📄 '}</span>
                {t('kit.report')}
              </a>
              <a className={linkButton} href={download(selected, 'sello')} download>
                <span aria-hidden="true">{'🏅 '}</span>
                {t('kit.seal')}
              </a>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor={textId} className="text-sm font-extrabold text-varsity-navy">
                <span aria-hidden="true">{'📱 '}</span>
                {t('kit.postLabel')}
              </label>
              <textarea id={textId} rows={8} value={post} onChange={(event) => setPost(event.target.value)} className="w-full rounded-2xl border-2 border-varsity-navy bg-white p-3 text-base text-ink" />
              <div className="mobile-stack grid gap-2 sm:grid-cols-2">
                <button type="button" className={linkButton} onClick={() => void copy()}>
                  <span aria-hidden="true">{'📋 '}</span>
                  {t('kit.copy')}
                </button>
                <a className={linkButton} href={whatsappShareUrl(post)} target="_blank" rel="noopener noreferrer">
                  <span aria-hidden="true">{'📤 '}</span>
                  {t('kit.share')}
                  {' '}
                  <span className="sr-only">{t('kit.newTab').trim()}</span>
                </a>
              </div>
            </div>
            <div role="status" data-testid="kit-copy-status" className="text-sm font-semibold text-varsity-navy">
              {copyResult === 'copied' ? (
                <p>
                  <span aria-hidden="true">{'✅ '}</span>
                  <span className="font-corp font-bold">{t('kit.copied')}</span>
                  {' · '}
                  {t('kit.copiedDescription')}
                </p>
              ) : null}
              {copyResult === 'manual' ? (
                <p>
                  <span aria-hidden="true">{'ℹ️ '}</span>
                  {t('kit.copyManual')}
                </p>
              ) : null}
            </div>
            <button type="button" className="min-h-11 font-bold text-varsity-navy underline underline-offset-4" onClick={() => dialog.current?.close()}>
              {t('kit.close')}
            </button>
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
