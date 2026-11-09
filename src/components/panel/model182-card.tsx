'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { formatCents } from '@/core/finance/money';
import { isValidContactPhone } from '@/core/tax/contact-phone';
import { isLocale } from '@/i18n/routing';

/**
 * Modelo 182 en el panel (Sprint 4.1, QA-REG02). Solo se ofrece la descarga si la Ley 49/2002 de la entidad está **verificada**; si no, se explica
 * qué reciben las familias en su lugar (un justificante nominativo de aportación, sin efectos fiscales). El fichero lo genera el servidor; aquí se
 * pide el ejercicio y el teléfono de contacto, y al terminar se dice cuántas personas entraron y cuántas aportaciones quedaron fuera.
 */

export interface Model182CardProps {
  orgSlug: string;
  verified: boolean;
  years: number[];
  defaultYear: number;
  defaultPhone: string;
}

type Outcome = { donors: number; totalCents: number; excluded: number; excludedCents: number; unresolved: number; unresolvedCents: number; returned: number; returnedCents: number };
type ErrorKey = 'PHONE_INVALID' | 'LEY49_NOT_VERIFIED' | 'DECLARANT_INCOMPLETE' | 'FORMAT' | 'FORBIDDEN' | 'GENERIC';

export function Model182Card({ orgSlug, verified, years, defaultYear, defaultPhone }: Model182CardProps) {
  const t = useTranslations('panel.model182');
  const locale = useLocale();
  const money = (cents: number) => formatCents(cents, isLocale(locale) ? locale : 'es');
  const ids = { year: useId(), phone: useId(), hint: useId(), error: useId() };
  const phoneField = useRef<HTMLInputElement>(null);
  const [year, setYear] = useState(defaultYear);
  const [phone, setPhone] = useState(defaultPhone);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  if (!verified) {
    return (
      <section aria-labelledby={`${ids.year}-title`} className="korum-notebook-sheet flex flex-col gap-2">
        <h2 id={`${ids.year}-title`} className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('title')}
        </h2>
        <p className="text-sm text-ink-soft">{t('notVerified')}</p>
      </section>
    );
  }

  async function download() {
    setOutcome(null);
    if (!isValidContactPhone(phone)) {
      setError('PHONE_INVALID');
      phoneField.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch('/api/panel/modelo-182', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgSlug, fiscalYear: year, contactPhone: phone }) });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        const known: ErrorKey[] = ['PHONE_INVALID', 'LEY49_NOT_VERIFIED', 'DECLARANT_INCOMPLETE', 'FORMAT', 'FORBIDDEN'];
        const key = known.find((candidate) => candidate === body.error) ?? 'GENERIC';
        setError(key);
        if (key === 'PHONE_INVALID') phoneField.current?.focus();
        return;
      }
      const number = (name: string) => Number(response.headers.get(name) ?? 0);
      setOutcome({
        donors: number('x-korum-donors'),
        totalCents: number('x-korum-total-cents'),
        excluded: number('x-korum-excluded'),
        excludedCents: number('x-korum-excluded-cents'),
        unresolved: number('x-korum-unresolved'),
        unresolvedCents: number('x-korum-unresolved-cents'),
        returned: number('x-korum-returned'),
        returnedCents: number('x-korum-returned-cents')
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `modelo182-${year}.txt`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('GENERIC');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${ids.year}-title`} className="korum-trust-vault flex flex-col gap-3 p-5">
      <h2 id={`${ids.year}-title`} className="font-corp text-lg font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      <p className="text-sm text-ink-soft">{t('intro')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={ids.year} className="flex flex-col gap-1 text-sm font-bold text-varsity-navy">
          {t('year')}
          <select id={ids.year} className="min-h-11 rounded-xl border-2 border-varsity-navy bg-white px-3 text-base text-ink" value={year} onChange={(event) => setYear(Number(event.target.value))}>
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <div className="flex min-w-48 flex-col gap-1">
          <label htmlFor={ids.phone} className="text-sm font-bold text-varsity-navy">
            {t('phone')}
          </label>
          <input
            ref={phoneField}
            id={ids.phone}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            aria-invalid={error === 'PHONE_INVALID'}
            aria-describedby={error === 'PHONE_INVALID' ? `${ids.hint} ${ids.error}` : ids.hint}
            className="min-h-11 rounded-xl border-2 border-varsity-navy bg-white px-3 text-base text-ink aria-invalid:border-red-700"
          />
        </div>
        <button type="button" className="tactile-btn" disabled={busy} onClick={() => void download()}>
          <span aria-hidden="true">{'📥 '}</span>
          {busy ? t('downloading') : t('download')}
        </button>
      </div>
      <p id={ids.hint} className="text-sm text-ink-soft">
        {t('phoneHint')}
      </p>
      <div id={ids.error} role="alert" className="text-sm font-semibold text-red-800">
        {error ? t(`errors.${error}`) : ''}
      </div>
      <div role="status" className="flex flex-col gap-1 text-sm text-varsity-navy">
        {outcome ? (
          <>
            <p className="font-bold">{t('result.done', { donors: outcome.donors, total: money(outcome.totalCents), year })}</p>
            {outcome.excluded > 0 ? <p>{t('result.excluded', { count: outcome.excluded, amount: money(outcome.excludedCents) })}</p> : null}
            {outcome.returned > 0 ? <p>{t('result.returned', { count: outcome.returned, amount: money(outcome.returnedCents) })}</p> : null}
            {outcome.unresolved > 0 ? <p>{t('result.unresolved', { count: outcome.unresolved, amount: money(outcome.unresolvedCents) })}</p> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
