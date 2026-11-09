'use client';

import { useEffect, useId, useRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

/**
 * Piezas comunes de los formularios de acceso y alta: campo con etiqueta, ayuda y error asociados (`aria-describedby`, `aria-invalid`), y
 * aviso de formulario anunciado (`role="alert"`) dentro del propio formulario (skill de interfaz §4: los errores van junto al campo).
 */

export const fieldClass = 'min-h-12 w-full rounded-xl border-2 border-varsity-navy bg-white px-4 text-base text-ink aria-invalid:border-red-700';
export const primaryButton = 'tactile-btn w-full justify-center disabled:cursor-not-allowed disabled:opacity-60';
export const secondaryButton =
  'inline-flex min-h-11 w-full items-center justify-center rounded-xl border-2 border-varsity-navy px-4 font-semibold text-varsity-navy hover:bg-varsity-navy/10 disabled:cursor-not-allowed disabled:opacity-60';
export const linkButton = 'min-h-11 font-semibold text-varsity-navy underline underline-offset-4 hover:text-varsity-emerald';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string | null;
}

export function Field({ label, hint, error, ...input }: FieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-bold text-varsity-navy">
        {label}
      </label>
      <input id={id} className={fieldClass} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-ink-soft">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Código de 6 dígitos (email o app de verificación): teclado numérico y autocompletado del sistema. */
export function CodeField(props: Omit<FieldProps, 'inputMode' | 'autoComplete' | 'pattern' | 'maxLength'> & { length?: number }) {
  const { length = 6, ...rest } = props;
  return <Field inputMode="numeric" autoComplete="one-time-code" pattern={`[0-9]{${length}}`} maxLength={length} required {...rest} className={`${fieldClass} font-corp text-center text-2xl tracking-[0.4em] tabular-nums`} />;
}

export function FormAlert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const styles = tone === 'error' ? 'border-red-700 bg-red-50 text-red-900' : tone === 'success' ? 'border-varsity-emerald bg-emerald-50 text-emerald-950' : 'border-varsity-navy bg-varsity-ivory text-varsity-navy';
  const ref = useRef<HTMLDivElement>(null);
  // Un error aparece cuando el botón que lo provocó está deshabilitado (se envía): sin esto, el foco caería al documento y quien usa
  // teclado o lector de pantalla perdería su sitio (revisión de experiencia del 3.2). Los avisos de éxito o información no mueven el foco.
  useEffect(() => {
    if (tone === 'error') ref.current?.focus();
  }, [tone, children]);
  return (
    <div ref={ref} tabIndex={tone === 'error' ? -1 : undefined} role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border-2 p-3 text-sm font-semibold ${styles}`}>
      {children}
    </div>
  );
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string | null;
  options: ReadonlyArray<{ value: string; label: string }>;
}

export function SelectField({ label, hint, error, options, ...select }: SelectProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-bold text-varsity-navy">
        {label}
      </label>
      <select id={id} className={fieldClass} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...select}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-ink-soft">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CheckboxField({ label, hint, error, ...input }: Omit<FieldProps, 'type'>) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-11 items-start gap-3">
        <input id={id} type="checkbox" className="mt-1 size-5 shrink-0 accent-varsity-emerald" aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
        <label htmlFor={id} className="font-semibold text-varsity-navy">
          {label}
        </label>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="ps-8 text-sm text-ink-soft">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="ps-8 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}
