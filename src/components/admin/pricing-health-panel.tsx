'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useId, useRef, useState, useTransition } from 'react';
import { acknowledgePricingAlertAction } from '@/app/[locale]/(superadmin)/admin/reglas/actions';
import type { EntityActionResult } from '@/app/[locale]/(superadmin)/admin/entidades/actions';
import { pricingMessageValues } from '@/core/finance/pricing-alert-format';
import type { ReviewedPricingAlert } from '@/core/finance/pricing-health';
import type { MoneyLocale } from '@/core/finance/money';
import { useToast } from '@/components/ui/toast-provider';
import { Link, useRouter } from '@/i18n/navigation';
import { focusLater } from './rules-action';
import { isLocale, type Locale } from '@/i18n/routing';
import { localizedPath } from '@/lib/seo/marketing-routes';

/** Un aviso con una marca si sale de valores aún sin guardar (no se puede aceptar: la aceptación se compara con las reglas guardadas). */
export type PricingAlertItem = ReviewedPricingAlert & { unsaved?: boolean };

const BUTTON = 'min-h-11 rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy hover:bg-varsity-navy/5 disabled:opacity-60';
/** Identificador estable del aviso en la página: el foco vuelve a él cuando se acepta (los botones desaparecen). */
const alertDomId = (alert: Pick<PricingAlertItem, 'code' | 'source'>) => `pricing-alert-${alert.code}${alert.source ? `-${alert.source}` : ''}`;
const NOTE_MIN = 10;
const NOTE_MAX = 600;

/**
 * Avisos de las reglas de precio (skill korum-tco-calculator §2.1): cada uno con la cifra concreta, en lenguaje llano y con texto además del icono. Ninguno bloquea
 * nada. **«Ajustar»** lleva al campo implicado (o lo enfoca, si el formulario está en la misma página) y **«Aceptar y registrar»** asume el aviso a propósito con una
 * nota obligatoria (queda en la auditoría). Un aviso aceptado no desaparece: se muestra atenuado con su nota; si cambia la configuración implicada, vuelve a saltar.
 */
export function PricingHealthPanel({ alerts, onAdjust, emptyText }: { alerts: PricingAlertItem[]; onAdjust?: (settingKey: string) => void; emptyText?: string }) {
  const t = useTranslations('admin.pricingHealth');
  const format = useFormatter();
  const current = useLocale();
  const moneyLocale: MoneyLocale = isLocale(current) ? current : 'es';

  // La región viva está siempre montada: una que aparece ya con contenido no se anuncia, y los avisos entran y salen mientras se escribe.
  if (alerts.length === 0) {
    return (
      <div aria-live="polite">
        <p className="text-ink-soft">{emptyText ?? t('none')}</p>
      </div>
    );
  }

  return (
    <div aria-live="polite">
    <ul className="flex flex-col gap-3" data-testid="pricing-health">
      {alerts.map((alert) => {
        const accepted = alert.acknowledgement;
        const critical = alert.severity === 'CRITICAL';
        return (
          <li
            key={`${alert.code}:${alert.source ?? ''}`}
            id={alertDomId(alert)}
            tabIndex={-1}
            data-pricing-alert={alert.code}
            data-accepted={accepted ? 'true' : 'false'}
            className={`flex flex-col gap-2 rounded-xl border-2 p-3 outline-offset-2 ${accepted ? 'border-patio-rule-strong bg-slate-50 text-ink-soft' : critical ? 'border-red-700 bg-red-50 text-red-950' : 'border-varsity-gold-deep bg-amber-50 text-amber-950'}`}
          >
            <p className="font-bold">
              <span aria-hidden="true">{critical ? '❗ ' : '⚠️ '}</span>
              <span className="me-2 rounded-full bg-white/70 px-2 py-0.5 text-xs font-extrabold">{t(critical ? 'severity.CRITICAL' : 'severity.WARNING')}</span>
              {t(`message.${alert.code}`, pricingMessageValues(alert, moneyLocale))}
            </p>
            {alert.source ? <p className="text-sm">{t('sourceLabel', { source: t(`source.${alert.source}`) })}</p> : null}
            <p className="text-sm">{accepted ? t('accepted', { date: format.dateTime(new Date(accepted.acknowledgedAt), { dateStyle: 'medium', timeZone: 'Europe/Madrid' }), note: accepted.note || t('noNote') }) : alert.unsaved ? t('unsaved') : t('open')}</p>
            {accepted ? null : <AlertActions alert={alert} onAdjust={onAdjust} />}
          </li>
        );
      })}
    </ul>
    </div>
  );
}

function AlertActions({ alert, onAdjust }: { alert: PricingAlertItem; onAdjust?: (settingKey: string) => void }) {
  const t = useTranslations('admin.pricingHealth');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<EntityActionResult | null>(null);
  const [failed, setFailed] = useState(false);
  const noteId = useId();
  const openerRef = useRef<HTMLButtonElement>(null);
  const firstKey = alert.settingKeys[0] ?? '';
  const trimmed = note.trim();
  const noteInvalid = result?.status === 'REJECTED' && result.fields.includes('note');

  const submit = () => {
    if (trimmed.length < NOTE_MIN) {
      setResult({ status: 'REJECTED', reason: 'INVALID', fields: ['note'] });
      document.getElementById(noteId)?.focus();
      return;
    }
    startTransition(async () => {
      setFailed(false);
      setResult(null);
      try {
        const outcome = await acknowledgePricingAlertAction({ target: { code: alert.code, fingerprint: alert.fingerprint, ...(alert.source ? { source: alert.source } : {}) }, note: trimmed });
        setResult(outcome);
        if (outcome.status === 'DONE') {
          toast({ tone: 'success', title: t('acceptedToast') });
          setOpen(false);
          setNote('');
          router.refresh();
          focusLater(alertDomId(alert));
        }
      } catch {
        setFailed(true);
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {onAdjust ? (
          <button type="button" className={BUTTON} onClick={() => onAdjust(firstKey)} data-testid="pricing-adjust">
            {t('adjust')}
          </button>
        ) : (
          <Link href={`/admin/reglas#rule-${firstKey}`} className={`${BUTTON} inline-flex items-center`} data-testid="pricing-adjust">
            {t('adjust')}
          </Link>
        )}
        <button
          ref={openerRef}
          type="button"
          className={BUTTON}
          aria-expanded={open}
          disabled={alert.unsaved}
          aria-describedby={alert.unsaved ? `${noteId}-unsaved` : undefined}
          onClick={() => {
            setOpen(true);
            requestAnimationFrame(() => document.getElementById(noteId)?.focus());
          }}
          data-testid="pricing-accept"
        >
          {t('accept')}
        </button>
      </div>
      {alert.unsaved ? (
        <p id={`${noteId}-unsaved`} className="text-sm">
          {t('saveFirst')}
        </p>
      ) : null}
      {open ? (
        <div className="flex flex-col gap-2 rounded-lg border-2 border-varsity-navy/20 bg-white p-3 text-ink">
          <label htmlFor={noteId} className="font-semibold">
            {t('noteLabel')}
          </label>
          <p id={`${noteId}-warning`} className="text-sm font-semibold">
            {t('acceptWarning')}
          </p>
          <p id={`${noteId}-hint`} className="text-sm text-ink-soft">
            {t('noteHint', { min: NOTE_MIN, max: NOTE_MAX })}
          </p>
          <textarea
            id={noteId}
            value={note}
            maxLength={NOTE_MAX}
            rows={3}
            onChange={(event) => setNote(event.target.value)}
            aria-invalid={noteInvalid}
            aria-describedby={noteInvalid ? `${noteId}-warning ${noteId}-hint ${noteId}-error` : `${noteId}-warning ${noteId}-hint`}
            className="w-full rounded-lg border-2 border-varsity-navy/30 bg-white p-3 text-base"
            data-testid="pricing-note"
          />
          {noteInvalid ? (
            <p id={`${noteId}-error`} role="alert" className="text-sm font-semibold text-red-900">
              {t('noteError', { min: NOTE_MIN })}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={submit} disabled={pending} className="min-h-11 rounded-xl bg-varsity-navy px-4 font-bold text-white hover:bg-varsity-navy-deep disabled:opacity-60" data-testid="pricing-accept-submit">
              {pending ? t('accepting') : t('acceptSubmit')}
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                setOpen(false);
                setResult(null);
                requestAnimationFrame(() => openerRef.current?.focus());
              }}
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm font-semibold text-red-900">
          {t('error.FAILED')}
        </p>
      ) : null}
      {result && result.status !== 'DONE' && !noteInvalid ? (
        <p role="alert" className="text-sm font-semibold text-red-900">
          {result.status === 'REJECTED' ? t(`error.${result.reason}` as 'error.ALERT_CHANGED') : t(`error.${result.status}`)}
          {result.status === 'REAUTH_REQUIRED' ? (
            <>
              {' '}
              <Link href={{ pathname: '/acceso/doble-factor', query: { next: localizedPath(locale, '/admin') } }} className="inline-flex min-h-11 items-center underline">
                {t('reauthLink')}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
