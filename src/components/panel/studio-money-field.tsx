'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Field } from '@/components/auth/auth-ui';
import { MoneyParseError, parseEurosToCents } from '@/core/finance/money';
import { isLocale } from '@/i18n/routing';

/**
 * Importe en euros que escribe una persona (`st-cost-mat`, `st-ticket-price`…). Se guarda en céntimos enteros: el texto se convierte sin coma flotante
 * (`parseEurosToCents`, con los separadores de su idioma). Mientras se teclea no se grita («12,» es un importe a medias): un importe mal escrito se avisa
 * junto al campo al salir de él, y el valor anterior se mantiene. Para cargar otra campaña se vuelve a montar con otra `key`.
 */

function initialText(cents: number, locale: 'es' | 'ca' | 'en'): string {
  const separator = locale === 'en' ? '.' : ',';
  const euros = Math.trunc(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(euros) : `${euros}${separator}${String(rest).padStart(2, '0')}`;
}

export function MoneyField({
  label,
  valueCents,
  maxCents,
  onChange,
  hint,
  disabled,
  error: outerError
}: {
  label: string;
  valueCents: number;
  maxCents: number;
  onChange: (cents: number) => void;
  hint?: string;
  disabled?: boolean;
  /** Aviso que viene de fuera (lo que falta para publicar), junto al campo. */
  error?: string | null;
}) {
  const t = useTranslations('panel.studio.fields');
  const current = useLocale();
  const locale = isLocale(current) ? current : 'es';
  const [text, setText] = useState(() => initialText(valueCents, locale));
  const [error, setError] = useState<string | null>(null);

  /** `null` si el texto no es un importe válido; el aviso solo lo pone `blur`. */
  function parse(next: string): { cents: number } | { problem: string } | null {
    try {
      const cents = parseEurosToCents(next, locale);
      if (cents < 0) return { problem: t('amountNegative') };
      if (cents > maxCents) return { problem: t('amountTooBig') };
      return { cents };
    } catch (problem) {
      if (!(problem instanceof MoneyParseError)) throw problem;
      return null;
    }
  }

  function change(next: string) {
    setText(next);
    const parsed = parse(next);
    if (parsed && 'cents' in parsed) {
      setError(null);
      onChange(parsed.cents);
    } else if (parsed) setError(parsed.problem);
  }

  function blur() {
    if (text.trim() === '') return setError(null);
    const parsed = parse(text);
    if (parsed === null) setError(t('amountInvalid'));
  }

  return <Field label={label} hint={hint} error={error ?? outerError} inputMode="decimal" autoComplete="off" value={text} disabled={disabled} onChange={(event) => change(event.target.value)} onBlur={blur} />;
}

/**
 * Número entero con límites (meta de familias por grupo). Se puede borrar y escribir otro valor sin que el campo lo corrija a cada pulsación («35» → «40»
 * pasaría por «5»): el valor se acota al salir del campo.
 */
export function IntField({ label, value, min, max, onChange, hint, disabled }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; hint?: string; disabled?: boolean }) {
  const [text, setText] = useState(String(value));

  function change(next: string) {
    setText(next);
    const parsed = Number(next);
    if (next.trim() !== '' && Number.isInteger(parsed) && parsed >= min && parsed <= max) onChange(parsed);
  }

  function blur() {
    const parsed = Math.trunc(Number(text));
    const clamped = Number.isFinite(parsed) && text.trim() !== '' ? Math.min(max, Math.max(min, parsed)) : value;
    setText(String(clamped));
    onChange(clamped);
  }

  return <Field type="number" inputMode="numeric" min={min} max={max} label={label} hint={hint} value={text} disabled={disabled} onChange={(event) => change(event.target.value)} onBlur={blur} />;
}
