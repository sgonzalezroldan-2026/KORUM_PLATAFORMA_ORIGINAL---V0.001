'use client';

import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { signIdeaAction } from '@/app/[locale]/(public)/[orgSlug]/ideas/actions';
import { ShareModal, type ShareTarget } from '@/components/portal/share-modal';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';
import { computeDeviceFingerprint } from '@/lib/device-fingerprint';
import { DeviceProtectionNotice } from './device-protection-notice';
import { IdeaCard, type IdeaCardData } from './idea-card';
import { ProposeIdeaDialog } from './propose-idea-dialog';

export interface IdeaBoardProps {
  orgSlug: string;
  locale: string;
  entityName: string;
  contentLang?: string;
  ideas: IdeaCardData[];
  /** Firmas verificadas que exige la entidad para que una idea pase al centro. */
  needed: number;
  maxDays: number;
  categories: { name: string; icon: string }[];
  signedIn: boolean;
  loginHref: string;
  fingerprintGranted: boolean;
  /** URL absoluta del buzón, para los enlaces de compartir. */
  pageUrl: string;
}

type Notice = { tone: 'ok' | 'info' | 'error'; text: string } | null;

const NOTICE_TONE = { ok: 'border-emerald-300 bg-emerald-50 text-emerald-950', info: 'border-sky-300 bg-sky-50 text-sky-950', error: 'border-red-700 bg-red-50 text-red-900' } as const;

/**
 * Buzón de ideas de la entidad (`id="fview-ideas"` del prototipo, QA-F09). Cabecera con «Proponer una idea», aviso de la cookie y la huella, y las
 * tarjetas con su firma en 1 clic. Todo resultado se anuncia en una región `aria-live` y la página se refresca desde el servidor, que es quien cuenta
 * las firmas: aquí nunca se suma un voto por cuenta propia.
 */
export function IdeaBoard({ orgSlug, locale, entityName, contentLang, ideas, needed, maxDays, categories, signedIn, loginHref, fingerprintGranted, pageUrl }: IdeaBoardProps) {
  const t = useTranslations('portal.ideas');
  const router = useRouter();
  const [notice, setNotice] = useState<Notice>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [granted, setGranted] = useState(fingerprintGranted);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);

  async function sign(ideaId: number) {
    setBusyId(ideaId);
    setNotice(null);
    try {
      // La huella solo se calcula con consentimiento: el ya dado o la casilla marcada ahora.
      const useFingerprint = granted || consentChecked;
      const fingerprint = useFingerprint ? await computeDeviceFingerprint() : undefined;
      const outcome = await signIdeaAction({ orgSlug, ideaId, fingerprint, fingerprintConsent: consentChecked && !granted ? true : undefined });
      if (outcome.status === 'SIGNED') {
        // La casilla vale para esta firma: una vez dado el consentimiento, vuelve a su estado de reposo (desmarcada).
        if (consentChecked && !granted) {
          setGranted(true);
          setConsentChecked(false);
        }
        setNotice(
          outcome.quorumReached
            ? { tone: 'ok', text: t('result.quorum') }
            : outcome.verified
              ? { tone: 'ok', text: t('result.signedVerified') }
              : { tone: 'info', text: t(outcome.reasonKey === 'ideas.audit.ipBurst' ? 'result.signedBurst' : 'result.signedReview') }
        );
        router.refresh();
      } else if (outcome.status === 'ALREADY_SIGNED') {
        setNotice({ tone: 'info', text: t('result.already') });
        router.refresh();
      } else if (outcome.status === 'LOGIN_REQUIRED') {
        setNotice({ tone: 'error', text: t('result.LOGIN_REQUIRED') });
      } else {
        setNotice({ tone: 'error', text: t(`result.${outcome.reason}`) });
      }
    } catch {
      setNotice({ tone: 'error', text: t('result.generic') });
    } finally {
      setBusyId(null);
      // La acción cambia el botón por un texto: el foco se queda en la tarjeta de esa idea y no se pierde en la cabecera (WCAG 2.4.3).
      requestAnimationFrame(() => document.getElementById(`idea-${ideaId}`)?.focus());
    }
  }

  function share(idea: IdeaCardData) {
    setShareTarget({ title: idea.title, entityName, url: `${pageUrl}#idea-${idea.id}`, groups: [], message: t('shareMessage', { title: idea.title, entity: entityName }) });
  }

  const proposeClass = 'tactile-btn rounded-2xl! font-joy text-sm';

  return (
    <div className="space-y-6">
      <section id="fview-ideas" aria-labelledby="ideas-title" className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-sky-200 bg-gradient-to-r from-sky-50 to-emerald-50 p-6">
        <div className="max-w-2xl space-y-2">
          <p className="inline-flex rounded-full bg-sky-700 px-3 py-0.5 text-xs font-extrabold uppercase text-white">{t('badge')}</p>
          <h1 id="ideas-title" lang={contentLang} className="font-joy text-2xl font-bold text-varsity-navy wrap-anywhere">
            {t('title', { name: entityName })}
          </h1>
          <p className="text-ink-soft">{t('intro', { min: needed, days: maxDays })}</p>
          {signedIn ? (
            <Link href="/mi-cuenta/propuestas" prefetch={false} className="inline-flex min-h-11 items-center font-bold text-varsity-navy underline">
              <span aria-hidden="true">{'💬 '}</span>
              {t('myProposals')}
            </Link>
          ) : null}
        </div>
        {signedIn ? (
          <button type="button" onClick={() => setProposeOpen(true)} className={proposeClass}>
            <span aria-hidden="true">{'💡 '}</span>
            {t('propose')}
          </button>
        ) : (
          <Link href={loginHref} prefetch={false} className={proposeClass}>
            <span aria-hidden="true">{'💡 '}</span>
            {t('proposeLogin')}
          </Link>
        )}
      </section>

      {signedIn ? <DeviceProtectionNotice granted={granted} checked={consentChecked} onCheckedChange={setConsentChecked} onWithdrawn={() => {
            setGranted(false);
            setConsentChecked(false);
          }} /> : null}

      {/* Región viva permanente: el texto se inyecta después, que es lo que los lectores de pantalla anuncian. Con aviso, flota abajo (no empuja las tarjetas). */}
      <div
        role="status"
        aria-live="polite"
        data-testid="idea-notice"
        className={clsx(notice ? 'fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-xl items-start gap-3 rounded-2xl border-2 p-4 font-bold shadow-xl' : 'sr-only', notice && NOTICE_TONE[notice.tone])}
      >
        <span className="min-w-0 flex-1">{notice?.text ?? ''}</span>
        {notice ? (
          <button type="button" onClick={() => setNotice(null)} aria-label={t('result.dismiss')} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-xl hover:bg-black/10">
            <span aria-hidden="true">{'✕'}</span>
          </button>
        ) : null}
      </div>

      {ideas.length === 0 ? (
        <EmptyState
          icon="💡"
          title={t('empty.title')}
          description={t('empty.description')}
          playful
          action={
            signedIn ? (
              <button type="button" onClick={() => setProposeOpen(true)} className={proposeClass}>
                {t('propose')}
              </button>
            ) : (
              <Link href={loginHref} prefetch={false} className={proposeClass}>
                {t('proposeLogin')}
              </Link>
            )
          }
        />
      ) : (
        <ul className="mobile-stack grid gap-5 md:grid-cols-2 lg:grid-cols-3" aria-label={t('listLabel')}>
          {ideas.map((idea) => (
            <li key={idea.id} className="flex">
              <div className="flex w-full flex-col">
                <IdeaCard idea={idea} needed={needed} contentLang={contentLang} signedIn={signedIn} loginHref={loginHref} busy={busyId === idea.id} onSign={sign} onShare={share} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <ProposeIdeaDialog open={proposeOpen} onClose={() => setProposeOpen(false)} onProposed={() => router.refresh()} orgSlug={orgSlug} locale={locale} categories={categories} />
      <ShareModal target={shareTarget} onClose={() => setShareTarget(null)} />
    </div>
  );
}
