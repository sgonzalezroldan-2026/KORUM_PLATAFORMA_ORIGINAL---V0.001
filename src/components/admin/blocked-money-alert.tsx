'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';
import { resolveAlertWithNoteAction, type NoteResolveResult } from '@/app/[locale]/(superadmin)/admin/actions';
import { formatCents, type MoneyLocale } from '@/core/finance/money';
import { useToast } from '@/components/ui/toast-provider';
import { useRouter } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import type { AlertFigures } from '@/repositories/console.repository';
import { FIELD, PRIMARY } from './entity-action';
import { focusLater } from './rules-action';

const NOTE_MIN = 10;
const NOTE_MAX = 600;

/**
 * Dinero que no se puede mover con los repartos de Paycomet (`PAYOUT_BLOCKED`, `ACTIVITY_FUND_WINDOW`; decisión del promotor, 2026-11-13): la consola **no mueve dinero ni
 * escribe asientos** para estos casos. Enseña las cifras, explica qué pasó y los pasos para resolverlo con Paycomet, y deja cerrar la alerta con una **nota obligatoria** de quien lo
 * gestiona (queda en la auditoría). Si el problema sigue, la tarea diaria la reabre sola.
 */
export function BlockedMoneyAlert({ alertId, type, figures, describedBy }: { alertId: string; type: 'PAYOUT_BLOCKED' | 'ACTIVITY_FUND_WINDOW'; figures: AlertFigures | null; describedBy: string }) {
  const t = useTranslations('admin.alerts.blocked');
  const format = useFormatter();
  const current = useLocale();
  const locale: MoneyLocale = isLocale(current) ? current : 'es';
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState('');
  const [result, setResult] = useState<NoteResolveResult | null>(null);
  const [failed, setFailed] = useState(false);
  const id = useId();
  // Qué ha pasado: un reparto que no sale (cobro contracargado o fuera de la ventana), una liquidación firmada sin aprobar, o dinero del Fondo ya fuera de la ventana.
  const kind = type === 'PAYOUT_BLOCKED' || figures?.reason === 'SPLIT_BLOCKED' ? 'split' : figures?.reason === 'SIGNED_NOT_APPROVED' ? 'unsigned' : 'window';
  const blockedCents = figures?.blockedCents ?? figures?.stuckCents ?? null;
  const amountCents = figures?.amountCents ?? null;
  const money = (cents: number | null) => (cents === null ? '—' : formatCents(cents, locale));
  const noteWrong = result?.status === 'INVALID';

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      setFailed(false);
      setResult(null);
      try {
        const outcome = await resolveAlertWithNoteAction({ alertId, note: note.trim() });
        setResult(outcome);
        if (outcome.status === 'RESOLVED') {
          toast({ tone: 'success', title: t('resolved') });
          router.refresh();
          document.getElementById('admin-alerts')?.focus();
        } else focusLater(outcome.status === 'INVALID' ? `${id}-note` : `${id}-resolve`);
      } catch {
        setFailed(true);
        focusLater(`${id}-resolve`);
      }
    });
  };

  return (
    <details className="rounded-xl border-2 border-red-700 bg-red-50 p-3 text-red-950" data-testid="blocked-money" data-kind={kind} open>
      <summary className="min-h-11 cursor-pointer font-bold">{t('summary')}</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="tabular-nums">
          {kind === 'split' ? (blockedCents === null ? t('splitTextGeneric') : t('splitText', { blocked: money(blockedCents) })) : null}
          {kind === 'split' && amountCents !== null ? ` ${t('amountLine', { amount: money(amountCents) })}` : null}
          {kind === 'unsigned' ? (amountCents !== null && figures?.deadline ? t('unsignedText', { amount: money(amountCents), deadline: format.dateTime(new Date(figures.deadline), { dateStyle: 'medium', timeZone: 'Europe/Madrid' }) }) : t('unsignedTextGeneric')) : null}
          {kind === 'window' ? t('windowText', { stuck: money(figures?.stuckCents ?? null), available: money(figures?.availableCents ?? null) }) : null}
        </p>
        <p className="font-semibold">{t('noMove')}</p>
        <ol className="ms-5 list-decimal">
          {(['step1', 'step2', 'step3'] as const).map((step) => (
            <li key={step}>{t(`${kind}.${step}`)}</li>
          ))}
        </ol>
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor={`${id}-note`} className="font-semibold">
            {t('noteLabel')}
          </label>
          <textarea
            id={`${id}-note`}
            value={note}
            rows={3}
            maxLength={NOTE_MAX}
            onChange={(event) => setNote(event.target.value)}
            aria-describedby={noteWrong ? `${id}-note-error ${id}-note-hint` : `${id}-note-hint`}
            aria-invalid={noteWrong}
            className={`${FIELD} h-auto py-2 text-ink`}
            data-testid="blocked-note"
          />
          <p id={`${id}-note-hint`} className="text-sm">
            {t('noteHint', { min: NOTE_MIN, max: NOTE_MAX })}
          </p>
          {noteWrong ? (
            <p id={`${id}-note-error`} role="alert" className="text-sm font-semibold">
              {t('noteError', { min: NOTE_MIN })}
            </p>
          ) : null}
          <p id={`${id}-close-hint`} className="text-sm font-semibold">
            {t('closeHint')}
          </p>
          <button id={`${id}-resolve`} type="submit" disabled={pending || note.trim().length < NOTE_MIN} aria-describedby={`${id}-note-hint ${id}-close-hint ${describedBy}`} className={`${PRIMARY} self-start`} data-testid="blocked-resolve">
            {pending ? t('resolving') : t('resolve')}
          </button>
          {failed ? (
            <p role="alert" className="text-sm font-semibold">
              {t('failed')}
            </p>
          ) : null}
          {result && result.status !== 'RESOLVED' && result.status !== 'INVALID' ? (
            <p role="alert" className="text-sm font-semibold">
              {t(`outcome.${result.status}`)}
            </p>
          ) : null}
        </form>
      </div>
    </details>
  );
}
