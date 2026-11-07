import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import { ProgressBar } from '@/components/portal/progress-bar';
import type { IdeaAction } from '@/core/ideas/idea-rules';
import { Link } from '@/i18n/navigation';

export interface IdeaCardData {
  id: number;
  /** `#FAM-1234`, siempre generado por KORUM. */
  alias: string;
  title: string;
  category: string;
  description: string;
  phase: 'PUBLIC_VOTING' | 'DOUBLE_CHECK';
  verifiedVotes: number;
  percent: number;
  quorumReached: boolean;
  daysRemaining: number;
  action: IdeaAction;
}

export interface IdeaCardProps {
  idea: IdeaCardData;
  needed: number;
  /** Idioma en el que la entidad escribe, si no es el de la página (el texto de la idea lo escribió una familia: se marca con el idioma de la entidad). */
  contentLang?: string;
  signedIn: boolean;
  loginHref: string;
  busy: boolean;
  onSign: (ideaId: number) => void;
  onShare: (idea: IdeaCardData) => void;
}

/**
 * Tarjeta de una idea (`function renderFamilyIdeas` del prototipo): hoja de cuaderno con washi tape, categoría, código anónimo, firmas y plazo. Muestra
 * solo el recuento de firmas **verificadas** (las sospechosas no suman al quórum y no se enseñan). Todo estado va también en texto, no solo en color.
 */
export function IdeaCard({ idea, needed, contentLang, signedIn, loginHref, busy, onSign, onShare }: IdeaCardProps) {
  const t = useTranslations('portal.ideas.card');
  const approved = idea.quorumReached || idea.phase === 'DOUBLE_CHECK';
  const actionClass = 'inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-center text-sm font-bold';

  return (
    <article id={`idea-${idea.id}`} tabIndex={-1} data-testid="idea-card" data-phase={idea.phase} className="korum-notebook-sheet flex w-full flex-1 flex-col justify-between gap-4 rounded-3xl border border-patio-rule p-5 pl-12 shadow-sm focus:outline-hidden focus-visible:outline-3 focus-visible:outline-varsity-gold-deep">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs font-extrabold">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className="inline-block h-2 w-6 shrink-0 -rotate-3 rounded-xs border border-amber-400 bg-amber-300/70" />
            <span lang={contentLang} className="die-cut-sticker truncate rounded-full bg-amber-100 px-2.5 py-0.5 text-amber-900">
              {idea.category}
            </span>
          </div>
          <span className="shrink-0 font-mono text-ink-soft">{t('code', { alias: idea.alias })}</span>
        </div>
        <h2 lang={contentLang} className="font-joy text-lg font-bold leading-snug text-varsity-navy wrap-anywhere">
          {idea.title}
        </h2>
        <p lang={contentLang} className="text-sm leading-relaxed text-ink-soft wrap-anywhere">
          {idea.description}
        </p>
        {approved ? (
          <p className="korum-stamp-badge">
            <span aria-hidden="true">{'★ '}</span>
            {t('approved')}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 text-sm font-bold tabular-nums">
          <span className="text-emerald-800">
            <span aria-hidden="true">{'👍 '}</span>
            {t('signatures', { count: idea.verifiedVotes, needed })}
          </span>
          {idea.phase === 'PUBLIC_VOTING' ? (
            <span className="text-ink-soft">
              <span aria-hidden="true">{'⏳ '}</span>
              {t('days', { days: idea.daysRemaining })}
            </span>
          ) : null}
        </div>
        <ProgressBar pct={idea.percent} label={t('progressLabel', { title: idea.title })} tone="sky" />
        <div className="flex flex-wrap gap-2 pt-1">
          {idea.action === 'SIGNED' ? (
            <p className={clsx(actionClass, 'bg-emerald-100 text-emerald-950')} data-testid="idea-signed">
              <span aria-hidden="true">{'✅ '}</span>
              {t('signed')}
            </p>
          ) : idea.action === 'CLOSED' ? (
            <p className={clsx(actionClass, 'bg-patio-rule text-ink-soft')}>{idea.phase === 'DOUBLE_CHECK' ? t('waitingCenter') : t('closed')}</p>
          ) : signedIn ? (
            <button type="button" onClick={() => onSign(idea.id)} disabled={busy} aria-busy={busy} aria-label={t('signAria', { title: idea.title })} className={clsx(actionClass, 'tactile-btn disabled:opacity-60')}>
              <span aria-hidden="true">{'✍️ '}</span>
              {busy ? t('signing') : t('sign')}
            </button>
          ) : (
            <Link href={loginHref} prefetch={false} className={clsx(actionClass, 'tactile-btn')}>
              <span aria-hidden="true">{'✍️ '}</span>
              {t('loginToSign')}
            </Link>
          )}
          <button type="button" onClick={() => onShare(idea)} aria-label={t('shareAria', { title: idea.title })} className={clsx(actionClass, 'flex-none border-2 border-patio-rule-strong text-varsity-navy')}>
            <span aria-hidden="true">{'📤 '}</span>
            {t('share')}
          </button>
        </div>
      </div>
    </article>
  );
}
