'use client';

import { useLocale, useTranslations } from 'next-intl';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { saveSectionAction, testConnectionAction } from '@/app/[locale]/(superadmin)/admin/ajustes/actions';
import type { EntityActionResult } from '@/app/[locale]/(superadmin)/admin/entidades/actions';
import { FIELD, OUTLINE as OUTLINE_BASE, PRIMARY as PRIMARY_BASE } from '@/components/admin/entity-action';
import { useToast } from '@/components/ui/toast-provider';
import { fieldI18nKey, SECTION_FIELDS, type FieldSpec, type SectionId } from '@/core/admin/settings-model';
import { Link, useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { localizedPath } from '@/lib/seo/marketing-routes';
import type { ConnectionTarget } from '@/services/admin/connection-tests';
import type { SettingFieldView, SettingSource } from '@/services/admin/platform-settings-view';

/**
 * Mientras una acción está en marcha los botones **no se deshabilitan** (`aria-disabled` y se ignoran los clics): un botón `disabled` pierde el foco y el teclado y los lectores de pantalla
 * se quedan en el aire. Así el foco sigue donde estaba.
 */
const BUSY = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-busy:cursor-wait';
export const PRIMARY = `${PRIMARY_BASE} ${BUSY}`;
export const OUTLINE = `${OUTLINE_BASE} ${BUSY}`;
export { FIELD };

/**
 * Lleva el foco a un control; si no existe (p. ej. un conflicto de versión que nombra un ajuste sin campo propio) o tras unos instantes sigue sin estar, al aviso de error visible de la pantalla
 * (`data-settings-alert`, enfocable): así el foco nunca cae al `<body>`.
 */
function focusOrAlert(id: string | undefined) {
  let attempts = 0;
  const attempt = () => {
    const target = (id ? document.getElementById(id) : null) as (HTMLElement & { disabled?: boolean }) | null;
    if (target && !target.disabled) return target.focus();
    attempts += 1;
    if (attempts < 12) return void setTimeout(attempt, 50);
    (document.querySelector('[data-settings-alert]') as HTMLElement | null)?.focus();
  };
  requestAnimationFrame(attempt);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Cambios sin guardar
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

interface UnsavedApi {
  register: (id: string, dirty: boolean) => void;
  hasUnsaved: () => boolean;
}
const UnsavedContext = createContext<UnsavedApi | null>(null);

/**
 * Recuerda qué bloques tienen cambios sin guardar. Avisa al cerrar o recargar la página (`beforeunload`) y, con un único detector de clics en los enlaces, **al seguir cualquier enlace que salga de
 * esta pantalla** (la cabecera, el logotipo, «Ver más cambios», el aviso de precios…): un enlace que solo cambia el ancla de la misma página no pregunta porque no pierde nada.
 */
export function UnsavedProvider({ children }: { children: ReactNode }) {
  const dirty = useRef(new Set<string>());
  const confirmedLeave = useRef(false);
  const message = useTranslations('admin.settings')('unsavedLeave');
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      // Si la persona acaba de aceptar salir (cerrar sesión recarga la página entera), el navegador no vuelve a preguntar.
      if (dirty.current.size === 0 || confirmedLeave.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const guardLinks = (event: globalThis.MouseEvent) => {
      if (dirty.current.size === 0 || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const element = (event.target as Element | null)?.closest?.('a[href], [data-confirm-leave]') as HTMLElement | null;
      if (!element) return;
      // Un botón que abandona la pantalla (cerrar sesión) se marca con `data-confirm-leave`: pregunta antes de hacer nada.
      const link = element instanceof HTMLAnchorElement ? element : null;
      if (link) {
        if (link.target === '_blank' || link.hasAttribute('download')) return;
        const target = new URL(link.href, window.location.href);
        const samePage = target.origin === window.location.origin && target.pathname === window.location.pathname && target.search === window.location.search && target.hash !== '';
        if (samePage) return;
      }
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Salida confirmada: durante unos segundos el aviso del navegador (`beforeunload`) no vuelve a preguntar. Si la navegación no llega a salir de la página (soft navigation), el aviso vuelve a valer.
      confirmedLeave.current = true;
      window.setTimeout(() => {
        confirmedLeave.current = false;
      }, 4000);
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', guardLinks, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', guardLinks, true);
    };
  }, [message]);
  const api = useMemo<UnsavedApi>(
    () => ({
      register: (id, isDirty) => void (isDirty ? dirty.current.add(id) : dirty.current.delete(id)),
      hasUnsaved: () => dirty.current.size > 0
    }),
    []
  );
  return <UnsavedContext.Provider value={api}>{children}</UnsavedContext.Provider>;
}

/** Marca un bloque como «con cambios sin guardar» mientras `dirty` sea cierto. */
export function useUnsaved(id: string, dirty: boolean) {
  const api = useContext(UnsavedContext);
  useEffect(() => {
    api?.register(id, dirty);
    return () => api?.register(id, false);
  }, [api, id, dirty]);
}

/** Enlace de vuelta a la consola (el detector de clics del proveedor avisa si hay cambios sin guardar). */
export function BackLink({ label }: { label: string }) {
  return (
    <Link href="/admin" className="inline-flex min-h-11 w-fit items-center font-bold text-varsity-navy underline">
      {label}
    </Link>
  );
}

/** Lleva el foco a un elemento cuando cambia `value` (no al montar): para cuando el enlace que se pulsó desaparece al cargar más contenido. */
export function FocusWhenChanged({ id, value }: { id: string; value: number }) {
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current !== value) document.getElementById(id)?.focus();
    previous.current = value;
  }, [id, value]);
  return null;
}

/** Identificador del control de un ajuste: el servidor devuelve la clave del campo que falla y la pantalla le lleva el foco. */
export const fieldId = (key: string) => `setting-${fieldI18nKey(key)}`;
export const fieldErrorId = (key: string) => `${fieldId(key)}-error`;

export const toText = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/**
 * Una acción de los ajustes: la lanza, anuncia el resultado (aviso si salió bien y texto junto al formulario si no), lleva el foco al primer campo rechazado y recarga la página con lo
 * guardado. Si caducó el segundo factor lo dice y enlaza a pasarlo otra vez; un fallo inesperado nunca se queda mudo. Mientras corre, una segunda llamada se ignora.
 */
export function useSettingsAction(options: { failureFocusId?: string } = {}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<EntityActionResult | null>(null);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);

  const run = (
    action: () => Promise<EntityActionResult>,
    doneMessage: (result: EntityActionResult & { status: 'DONE' }) => string,
    onDone?: (result: EntityActionResult & { status: 'DONE' }) => void,
    onFail?: () => void
  ) => {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      setFailed(false);
      setOutcome(null);
      try {
        const result = await action();
        setOutcome(result);
        if (result.status === 'DONE') {
          toast({ tone: 'success', title: doneMessage(result) });
          onDone?.(result);
          router.refresh();
        } else {
          onFail?.();
          focusOrAlert(result.status === 'REJECTED' && result.fields[0] ? fieldId(result.fields[0]) : options.failureFocusId);
        }
      } catch {
        setFailed(true);
        onFail?.();
        focusOrAlert(options.failureFocusId);
      } finally {
        busy.current = false;
      }
    });
  };

  return { run, pending, outcome, failed, reset: () => setOutcome(null) };
}

/** Nombre legible de un campo o de un secreto a partir de su clave (para decir qué falta o qué se rechaza). */
export function useLabelOf() {
  const t = useTranslations('admin.settings');
  return (key: string): string => {
    const id = fieldI18nKey(key);
    if (t.has(`fields.${id}.label`)) return t(`fields.${id}.label`);
    if (t.has(`secrets.${id}.label`)) return t(`secrets.${id}.label`);
    if (key.startsWith('platform.company.')) return t(`company.fields.${key.slice('platform.company.'.length)}` as 'company.fields.taxId');
    const legal = /^legal\.(terminos|privacidad|cookies|aviso-legal)\.(es|ca|en)$/.exec(key);
    if (legal) return t('history.targets.legal', { document: t(`legal.documents.${legal[1] as 'terminos'}`), locale: t(`legal.locales.${legal[2] as 'es'}`) });
    if (key === 'version') return t('legal.version');
    if (key === 'markdown') return t('legal.text');
    if (key === 'status') return t('legal.statusLabel');
    return key;
  };
}

/** Texto de un resultado que no es «hecho»: qué ha pasado, qué campos y, si toca, el enlace para volver a verificar la identidad o el botón para recargar. Se lleva a la vista al aparecer. */
export function SettingsOutcome({ outcome, failed, id }: { outcome: EntityActionResult | null; failed: boolean; id?: string }) {
  const t = useTranslations('admin.settings');
  const locale = useLocale() as Locale;
  const labelOf = useLabelOf();
  const ref = useRef<HTMLParagraphElement>(null);
  const visible = failed || (outcome !== null && outcome.status !== 'DONE');
  useEffect(() => {
    // Un mensaje bajo el botón puede quedar fuera de la pantalla (sobre todo en móvil): se lleva a la vista sin mover el foco.
    if (visible) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [visible, outcome]);
  const reload = (
    <>
      {' '}
      <button type="button" onClick={() => window.location.reload()} className="inline-flex min-h-11 items-center font-bold underline">
        {t('reload')}
      </button>
    </>
  );
  if (failed) {
    return (
      <p ref={ref} id={id} role="alert" tabIndex={-1} data-settings-alert="true" className="text-sm font-semibold text-red-900 outline-offset-4">
        {t('outcome.FAILED')}
        {reload}
      </p>
    );
  }
  if (!outcome || outcome.status === 'DONE') return null;
  return (
    <p ref={ref} id={id} role="alert" tabIndex={-1} data-settings-alert="true" className="text-sm font-semibold text-red-900 outline-offset-4" data-testid="settings-outcome">
      {outcome.status === 'REJECTED' ? t(`reason.${outcome.reason}` as 'reason.INVALID') : t(`outcome.${outcome.status}`)}
      {outcome.status === 'REJECTED' && outcome.fields.length > 0 ? ` ${t('rejectedFields', { fields: outcome.fields.map(labelOf).join(', ') })}` : ''}
      {outcome.status === 'REAUTH_REQUIRED' ? (
        <>
          {' '}
          <Link href={{ pathname: '/acceso/doble-factor', query: { next: localizedPath(locale, '/admin/ajustes') } }} className="inline-flex min-h-11 items-center underline">
            {t('reauthLink')}
          </Link>
        </>
      ) : null}
      {outcome.status === 'REJECTED' && outcome.reason === 'STALE' ? reload : null}
    </p>
  );
}

/** Texto que se pone junto a un campo rechazado: el motivo concreto o, si es solo «no válido», que revise su formato. */
export function useFieldError(outcome: EntityActionResult | null) {
  const t = useTranslations('admin.settings');
  return (key: string): string | null => {
    if (outcome?.status !== 'REJECTED' || !outcome.fields.includes(key)) return null;
    return outcome.reason === 'INVALID' ? t('fieldInvalid') : t(`reason.${outcome.reason}` as 'reason.INVALID');
  };
}

interface SettingFieldProps {
  spec: FieldSpec;
  value: string;
  onChange: (value: string) => void;
  source: SettingSource;
  /** Texto del error de este campo (lo enlaza `aria-describedby` y marca el campo como no válido). */
  error?: string | null;
  disabled?: boolean;
}

/** Un ajuste sencillo: su etiqueta, su ayuda, de dónde sale el valor mostrado y, si el servidor lo rechazó, marcado como no válido con su mensaje al lado. */
export function SettingField({ spec, value, onChange, source, error = null, disabled = false }: SettingFieldProps) {
  const t = useTranslations('admin.settings');
  const id = fieldId(spec.key);
  const i18n = fieldI18nKey(spec.key);
  const helpId = `${id}-help`;
  const common = {
    id,
    disabled,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${helpId} ${fieldErrorId(spec.key)}` : helpId,
    className: `${FIELD} scroll-mt-24 aria-invalid:border-red-700`
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold text-varsity-navy">
        {t(`fields.${i18n}.label`)}
      </label>
      {spec.kind === 'select' ? (
        <select {...common} value={value} onChange={(event) => onChange(event.target.value)}>
          {spec.options?.map((option) => (
            <option key={option} value={option}>
              {t(`fields.${i18n}.options.${option}`)}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...common}
          type="text"
          inputMode={spec.inputMode === 'email' ? 'email' : spec.inputMode === 'numeric' ? 'numeric' : 'text'}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={spec.maxLength}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {error ? (
        <p id={fieldErrorId(spec.key)} className="text-sm font-semibold text-red-900">
          {error}
        </p>
      ) : null}
      <p id={helpId} className="text-sm text-ink-soft">
        {t(`fields.${i18n}.help`)}
        {source === 'env' ? ` ${t('sourceEnv')}` : ''}
      </p>
    </div>
  );
}

/** Estado y acciones de un bloque de campos sencillos: lo escrito, qué versión de cada ajuste se veía y el guardado de todo el bloque a la vez. */
export function useSectionForm(section: SectionId, fields: Record<string, SettingFieldView>) {
  const t = useTranslations('admin.settings');
  const specs = SECTION_FIELDS[section].filter((spec) => spec.kind !== 'json');
  const [values, setValues] = useState<Record<string, string>>(() =>
    // Un selector con un valor guardado que ya no se ofrece (p. ej. SMTP, que no tiene adaptador) arranca en la primera opción: así el bloque se puede guardar y corregir desde la pantalla.
    Object.fromEntries(
      specs.map((spec) => [spec.key, spec.kind === 'select' && spec.options && !spec.options.includes(toText(fields[spec.key]?.value)) ? (spec.options[0] ?? '') : toText(fields[spec.key]?.value)])
    )
  );
  const action = useSettingsAction();
  const errorOf = useFieldError(action.outcome);
  const [baseline, setBaseline] = useState(() => JSON.stringify(values));
  useUnsaved(`section-${section}`, JSON.stringify(values) !== baseline);
  const setValue = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));
  const submit = (extra: Record<string, unknown> = {}, confirmations: string[] = [], onSaved?: () => void) => {
    const all: Record<string, unknown> = { ...values, ...extra };
    const versions = Object.fromEntries(Object.keys(all).map((key) => [key, fields[key]?.version ?? 0]));
    const snapshot = JSON.stringify(values);
    action.run(
      () => saveSectionAction({ section, values: all, versions, confirmations }),
      (result) => (result.detail === '0' ? t('savedNoChanges') : t('saved')),
      () => {
        setBaseline(snapshot);
        onSaved?.();
      }
    );
  };
  return { specs, values, setValue, submit, errorOf, ...action };
}

/** Formulario de un bloque: Intro (o el botón) guarda, sin la validación nativa del navegador (los errores los dice la pantalla, en su idioma y asociados al campo). */
export function SectionForm({ onSubmit, children, className = 'flex flex-col gap-4', testId }: { onSubmit: () => void; children: ReactNode; className?: string; testId?: string }) {
  return (
    <form
      noValidate
      className={className}
      data-testid={testId}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/** Botón de guardar de un bloque (envía el formulario), con su texto de resultado en una región que ya existe cuando se anuncia. */
export function SaveBar({ pending, outcome, failed, testId, children }: { pending: boolean; outcome: EntityActionResult | null; failed: boolean; testId: string; children?: ReactNode }) {
  const t = useTranslations('admin.settings');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-disabled={pending} aria-busy={pending} onClick={(event) => pending && event.preventDefault()} className={PRIMARY} data-testid={testId}>
          {pending ? t('saving') : t('save')}
        </button>
        {children}
      </div>
      <SettingsOutcome outcome={outcome} failed={failed} />
    </div>
  );
}

type TestMessage = { tone: 'ok' | 'info' | 'warn' | 'error'; text: string; reauth?: boolean };
const TONE = {
  ok: { icon: '✔ ', color: 'text-emerald-900' },
  info: { icon: 'ℹ ', color: 'text-varsity-navy' },
  warn: { icon: '⚠ ', color: 'text-amber-900' },
  error: { icon: '✖ ', color: 'text-red-900' }
} as const;

/** «Probar conexión»: llama al servidor con lo ya guardado y dice, con texto, qué ha pasado. Una región `aria-live` siempre montada anuncia el resultado. */
export function ConnectionTest({ target }: { target: ConnectionTarget }) {
  const t = useTranslations('admin.settings');
  const locale = useLocale() as Locale;
  const labelOf = useLabelOf();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<TestMessage | null>(null);
  const statusId = useId();
  const busy = useRef(false);

  const run = () => {
    if (busy.current) return;
    busy.current = true;
    startTransition(async () => {
      setMessage(null);
      try {
        const response = await testConnectionAction(target);
        if (response.status !== 'RESULT') {
          setMessage(response.status === 'REAUTH_REQUIRED' ? { tone: 'error', text: t('outcome.REAUTH_REQUIRED'), reauth: true } : { tone: 'error', text: t('outcome.INVALID_INPUT') });
          return;
        }
        const { result } = response;
        if (result.status === 'OK') setMessage({ tone: 'ok', text: t('test.OK') });
        else if (result.status === 'SIMULATED') setMessage({ tone: 'info', text: t(`test.SIMULATED_${target}`) });
        else if (result.status === 'NOT_CONFIGURED') setMessage({ tone: 'warn', text: t('test.NOT_CONFIGURED', { missing: result.missing.map(labelOf).join(', ') }) });
        else if (result.status === 'RATE_LIMITED') setMessage({ tone: 'warn', text: t('test.RATE_LIMITED') });
        else if (result.code === 'CONFIG') setMessage({ tone: 'error', text: t('test.CONFIG') });
        else if (result.code === 'NETWORK') setMessage({ tone: 'warn', text: t('test.NETWORK') });
        else setMessage({ tone: 'error', text: t('test.FAILED', { code: result.code }) });
      } catch {
        setMessage({ tone: 'error', text: t('outcome.FAILED') });
      } finally {
        busy.current = false;
      }
    });
  };

  const tone = message ? TONE[message.tone] : null;
  return (
    <div className="flex flex-col gap-2" data-testid={`test-${target}`}>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={run} aria-disabled={pending} aria-busy={pending} aria-describedby={statusId} className={OUTLINE} data-testid={`test-${target}-button`}>
          {pending ? t('testing') : t('testButton')}
        </button>
        <span className="text-sm text-ink-soft">{t('testHint')}</span>
      </div>
      <p id={statusId} role="status" aria-live="polite" className={`min-h-6 text-sm font-semibold ${tone?.color ?? ''}`} data-testid={`test-${target}-result`}>
        {message && tone ? `${tone.icon}${message.text}` : ''}
        {message?.reauth ? (
          <>
            {' '}
            <Link href={{ pathname: '/acceso/doble-factor', query: { next: localizedPath(locale, '/admin/ajustes') } }} className="inline-flex min-h-11 items-center underline">
              {t('reauthLink')}
            </Link>
          </>
        ) : null}
      </p>
    </div>
  );
}
