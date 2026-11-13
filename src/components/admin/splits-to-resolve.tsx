'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useId, useRef, useState, useTransition } from 'react';
import { resolveSplitAction, type SplitActionResult } from '@/app/[locale]/(superadmin)/admin/actions';
import { formatCents, type MoneyLocale } from '@/core/finance/money';
import { useToast } from '@/components/ui/toast-provider';
import { Link, useRouter } from '@/i18n/navigation';
import { isLocale, type Locale } from '@/i18n/routing';
import { localizedPath } from '@/lib/seo/marketing-routes';
import type { SplitToResolve } from '@/services/admin/payout-review.service';
import { FIELD, OUTLINE, PRIMARY } from './entity-action';
import { focusLater } from './rules-action';

/**
 * Repartos de resultado desconocido (campaña y Fondo de actividades): Paycomet no confirmó si el reparto salió y **nadie lo reenvía solo** (podría pagar dos veces). Una persona
 * mira en Paycomet qué pasó y lo dice aquí: «sí salió» (con el código de autorización del reparto) o «no salió» (vuelve a estar pendiente y se reenvía). Cada opción avisa de
 * lo que pasa si no es cierta y pide una confirmación final. Mueve dinero en el libro mayor, así que pide el segundo factor reciente.
 */
export function SplitsToResolve({ splits }: { splits: SplitToResolve[] }) {
  const t = useTranslations('admin.splits');
  if (splits.length === 0) return <p className="text-ink-soft">{t('none')}</p>;
  return (
    <ul className="flex flex-col gap-3" data-testid="splits-to-resolve">
      {splits.map((split) => (
        <SplitRow key={`${split.kind}:${split.splitId}`} split={split} />
      ))}
    </ul>
  );
}

function SplitRow({ split }: { split: SplitToResolve }) {
  const t = useTranslations('admin.splits');
  const format = useFormatter();
  const current = useLocale();
  const locale: MoneyLocale = isLocale(current) ? current : 'es';
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<'DONE' | 'NOT_DONE' | null>(null);
  const [code, setCode] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SplitActionResult | null>(null);
  const [failed, setFailed] = useState(false);
  const confirmTitle = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const codeWrong = result?.status === 'INVALID';
  const ready = choice === 'NOT_DONE' || (choice === 'DONE' && code.trim().length >= 3);

  const resolve = () => {
    setConfirming(false);
    startTransition(async () => {
      setFailed(false);
      setResult(null);
      try {
        const outcome = await resolveSplitAction({ kind: split.kind, splitId: split.splitId, splitAuthCode: choice === 'DONE' ? code.trim() : null });
        setResult(outcome);
        if (outcome.status === 'RESOLVED') {
          toast({ tone: 'success', title: t(outcome.done ? 'doneYes' : 'doneNo') });
          router.refresh();
          // La fila desaparece de la lista: el foco pasa al titular de la sección.
          focusLater('splits-title');
        } else if (outcome.status === 'NOT_SENDING') {
          router.refresh();
          focusLater('splits-title');
        } else focusLater(outcome.status === 'INVALID' ? `${id}-code` : `${id}-submit`);
      } catch {
        setFailed(true);
        focusLater(`${id}-submit`);
      }
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // Una confirmación final para las dos opciones: marcar «sí salió» sin que sea cierto deja a la entidad sin cobrar y marcar «no salió» cuando sí salió la hace cobrar dos veces.
    setConfirming(true);
    requestAnimationFrame(() => confirmTitle.current?.focus());
  };

  return (
    <li className="flex flex-col gap-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-3" data-split={`${split.kind}:${split.splitId}`}>
      <p className="font-bold text-amber-950">
        <span aria-hidden="true">{'⚠️ '}</span>
        {t('title', { kind: t(`kind.${split.kind}`), organization: split.organizationName, amount: formatCents(split.amountCents, locale) })}
      </p>
      <dl className="grid gap-1 text-sm md:grid-cols-3">
        <div>
          <dt className="text-ink-soft">{t('order')}</dt>
          <dd className="break-all font-mono font-bold">{split.paycometOrder ?? t('unknown')}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">{t('destination')}</dt>
          <dd className="break-all font-mono font-bold">{split.destinationSplitId ?? t('unknown')}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">{t('sentAt')}</dt>
          <dd className="font-bold">{split.sentAt ? format.dateTime(new Date(split.sentAt), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' }) : t('unknown')}</dd>
        </div>
      </dl>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <fieldset className="flex flex-col gap-1" disabled={confirming}>
          <legend id={`${id}-legend`} className="text-sm font-semibold text-amber-950">
            {t('legend')}
          </legend>
          {(['DONE', 'NOT_DONE'] as const).map((option) => (
            <label key={option} className="flex min-h-11 items-center gap-2">
              <input type="radio" name={`${id}-choice`} checked={choice === option} onChange={() => setChoice(option)} className="size-5" />
              <span>{t(`choice.${option}`)}</span>
            </label>
          ))}
        </fieldset>
        {choice === 'DONE' ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-code`} className="text-sm font-semibold">
              {t('code')}
            </label>
            <input
              id={`${id}-code`}
              type="text"
              value={code}
              maxLength={100}
              disabled={confirming}
              onChange={(event) => setCode(event.target.value)}
              aria-invalid={codeWrong}
              aria-describedby={codeWrong ? `${id}-code-error` : undefined}
              className={`${FIELD} font-mono`}
              autoComplete="off"
            />
            {codeWrong ? (
              <p id={`${id}-code-error`} role="alert" className="text-sm font-semibold text-red-900">
                {t('codeError')}
              </p>
            ) : null}
          </div>
        ) : null}
        {choice !== null ? <p className="text-sm font-semibold text-amber-950">{t(choice === 'DONE' ? 'warning' : 'warningNotDone')}</p> : null}
        <button id={`${id}-submit`} type="submit" disabled={!ready || pending || confirming} aria-describedby={`${id}-legend`} className={`${PRIMARY} self-start`} data-testid="split-submit">
          {pending ? t('saving') : t('save')}
        </button>
        {confirming ? (
          <div
            role="group"
            aria-label={t('confirmTitle')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setConfirming(false);
                focusLater(`${id}-submit`);
              }
            }}
            className="flex flex-col gap-2 rounded-xl border-2 border-varsity-navy bg-white p-3"
            data-testid="split-confirm"
          >
            <p ref={confirmTitle} tabIndex={-1} className="font-bold text-varsity-navy outline-offset-2">
              {t('confirmTitle')}
            </p>
            <p>{choice === 'DONE' ? t('confirmDone', { code: code.trim() }) : t('confirmNotDone')}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={PRIMARY} onClick={resolve} data-testid="split-confirm-yes">
                {t('confirmYes')}
              </button>
              <button
                type="button"
                className={OUTLINE}
                onClick={() => {
                  setConfirming(false);
                  focusLater(`${id}-submit`);
                }}
              >
                {t('confirmBack')}
              </button>
            </div>
          </div>
        ) : null}
        {failed ? (
          <p role="alert" className="text-sm font-semibold text-red-900">
            {t('failed')}
          </p>
        ) : null}
        {result && result.status !== 'RESOLVED' && result.status !== 'INVALID' ? (
          <p role="alert" className="text-sm font-semibold text-red-900">
            {t(`outcome.${result.status}`)}
            {result.status === 'REAUTH_REQUIRED' ? <ReauthLink /> : null}
          </p>
        ) : null}
      </form>
    </li>
  );
}

function ReauthLink() {
  const t = useTranslations('admin.splits');
  const locale = useLocale() as Locale;
  return (
    <>
      {' '}
      <Link href={{ pathname: '/acceso/doble-factor', query: { next: localizedPath(locale, '/admin') } }} className="inline-flex min-h-11 items-center underline">
        {t('reauthLink')}
      </Link>
    </>
  );
}
