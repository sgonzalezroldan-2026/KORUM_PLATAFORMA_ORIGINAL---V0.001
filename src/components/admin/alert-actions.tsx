'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';
import { resolveAlertAction, resolveStuckAction, type AlertActionResult } from '@/app/[locale]/(superadmin)/admin/actions';
import { useToast } from '@/components/ui/toast-provider';
import { Link, useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { localizedPath } from '@/lib/seo/marketing-routes';

const BUTTON = 'min-h-11 rounded-xl border-2 border-varsity-navy px-4 font-bold text-varsity-navy hover:bg-varsity-navy/5 disabled:opacity-60';
const FIELD = 'min-h-11 w-full rounded-lg border-2 border-varsity-navy/30 bg-white px-3 text-base';

/** Tras resolver, la alerta desaparece de la lista: el foco pasa al titular de la bandeja para que nadie lo pierda (WCAG 2.4.3). */
function focusAlertsHeading() {
  document.getElementById('admin-alerts')?.focus();
}

/** Mensaje de un resultado que no es «hecho» (o de un fallo inesperado); `REAUTH_REQUIRED` enlaza a volver a poner el código de verificación. */
function Outcome({ result, failed }: { result: AlertActionResult | null; failed: boolean }) {
  const t = useTranslations('admin.alerts');
  const locale = useLocale() as Locale;
  if (failed) {
    return (
      <p role="alert" className="text-sm font-semibold text-red-900">
        {t('failed')}
      </p>
    );
  }
  if (!result || result.status === 'RESOLVED') return null;
  return (
    <p role="alert" className="text-sm font-semibold text-red-900">
      {t(`outcome.${result.status}`)}
      {result.status === 'REAUTH_REQUIRED' ? (
        <>
          {' '}
          <Link href={{ pathname: '/acceso/doble-factor', query: { next: localizedPath(locale, '/admin') } }} className="inline-flex min-h-11 items-center underline">
            {t('reauthLink')}
          </Link>
        </>
      ) : null}
    </p>
  );
}

/** Marca una alerta como resuelta; la página se recarga con la lista nueva y se anuncia el resultado. */
export function ResolveAlertButton({ alertId, describedBy }: { alertId: string; describedBy?: string }) {
  const t = useTranslations('admin.alerts');
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<AlertActionResult | null>(null);
  const [failed, setFailed] = useState(false);

  const resolve = () =>
    startTransition(async () => {
      setFailed(false);
      try {
        const outcome = await resolveAlertAction({ alertId });
        setResult(outcome);
        if (outcome.status === 'RESOLVED') toast({ tone: 'success', title: t('resolved') });
        router.refresh();
        if (outcome.status === 'RESOLVED') focusAlertsHeading();
      } catch {
        setFailed(true);
      }
    });

  return (
    <div className="flex flex-col gap-1">
      <button type="button" onClick={resolve} disabled={pending} aria-describedby={describedBy} className={BUTTON} data-testid="resolve-alert">
        {pending ? t('resolving') : t('resolve')}
      </button>
      <Outcome result={result} failed={failed} />
    </div>
  );
}

type RefundChoice = 'REFUNDED' | 'NOT_REFUNDED';
type InvoiceChoice = 'RETRY' | 'ACCEPTED' | 'ACCEPTED_WITH_ERRORS' | 'REJECTED';

/**
 * Una devolución o una factura se quedaron sin respuesta: una persona ha mirado en Paycomet o en el proveedor qué pasó y lo dice aquí. Pide el
 * segundo factor reciente; si caducó, lo dice y enlaza a pasarlo otra vez. «Sí devolvió» asienta la devolución sin más prueba que esa persona.
 * Es la única forma de cerrar estas alertas.
 */
export function StuckResolver({ alertType, id }: { alertType: 'REFUND_STUCK' | 'INVOICE_STUCK'; id: number }) {
  const t = useTranslations('admin.alerts');
  const ts = useTranslations('admin.alerts.stuck');
  const router = useRouter();
  const { toast } = useToast();
  const groupId = useId();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<AlertActionResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [refundChoice, setRefundChoice] = useState<RefundChoice | null>(null);
  const [invoiceChoice, setInvoiceChoice] = useState<InvoiceChoice | null>(null);
  const [reference, setReference] = useState('');
  const isRefund = alertType === 'REFUND_STUCK';
  const ready = isRefund ? refundChoice !== null : invoiceChoice !== null;

  const submit = () =>
    startTransition(async () => {
      setFailed(false);
      try {
        let outcome: AlertActionResult;
        if (isRefund) outcome = await resolveStuckAction({ kind: 'REFUND', contributionId: id, refunded: refundChoice === 'REFUNDED' });
        else if (invoiceChoice === 'RETRY') outcome = await resolveStuckAction({ kind: 'INVOICE_RETRY', invoiceId: id });
        else outcome = await resolveStuckAction({ kind: 'INVOICE_REGISTERED', invoiceId: id, status: invoiceChoice as 'ACCEPTED' | 'ACCEPTED_WITH_ERRORS' | 'REJECTED', providerReference: reference.trim() || null });
        setResult(outcome);
        if (outcome.status === 'RESOLVED') {
          toast({ tone: 'success', title: t('resolved') });
          router.refresh();
          focusAlertsHeading();
        }
      } catch {
        setFailed(true);
      }
    });

  const options: Array<{ value: string; label: string }> = isRefund
    ? [
        { value: 'REFUNDED', label: ts('refund.done') },
        { value: 'NOT_REFUNDED', label: ts('refund.notDone') }
      ]
    : [
        { value: 'RETRY', label: ts('invoice.retry') },
        { value: 'ACCEPTED', label: ts('invoice.accepted') },
        { value: 'ACCEPTED_WITH_ERRORS', label: ts('invoice.acceptedWithErrors') },
        { value: 'REJECTED', label: ts('invoice.rejected') }
      ];

  return (
    <details className="rounded-xl border-2 border-varsity-navy/20 bg-white p-3" data-testid="stuck-resolver">
      <summary className="min-h-11 cursor-pointer font-bold text-varsity-navy">{isRefund ? ts('refund.summary') : ts('invoice.summary')}</summary>
      <fieldset className="mt-3 flex flex-col gap-2">
        <legend className="text-sm text-ink-soft">{isRefund ? ts('refund.legend') : ts('invoice.legend')}</legend>
        {options.map((option) => (
          <label key={option.value} className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name={`${groupId}-choice`}
              value={option.value}
              checked={(isRefund ? refundChoice : invoiceChoice) === option.value}
              onChange={() => (isRefund ? setRefundChoice(option.value as RefundChoice) : setInvoiceChoice(option.value as InvoiceChoice))}
              className="size-5"
            />
            <span>{option.label}</span>
          </label>
        ))}
        {!isRefund && invoiceChoice !== null && invoiceChoice !== 'RETRY' ? (
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink-soft">
            {ts('invoice.reference')}
            <input type="text" value={reference} maxLength={120} onChange={(event) => setReference(event.target.value)} className={FIELD} autoComplete="off" />
          </label>
        ) : null}
        {isRefund && refundChoice === 'REFUNDED' ? <p className="text-sm text-amber-950">{ts('refund.warning')}</p> : null}
        <button type="button" onClick={submit} disabled={!ready || pending} className={BUTTON} data-testid="stuck-submit">
          {pending ? ts('saving') : ts('save')}
        </button>
        <Outcome result={result} failed={failed} />
      </fieldset>
    </details>
  );
}
