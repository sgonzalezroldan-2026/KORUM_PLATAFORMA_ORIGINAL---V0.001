'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { EntityActionResult } from '@/app/[locale]/(superadmin)/admin/entidades/actions';
import { useToast } from '@/components/ui/toast-provider';
import { Link, useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { localizedPath } from '@/lib/seo/marketing-routes';

/** Mueve el foco cuando el botón que lo tenía se deshabilita o desaparece (WCAG 2.4.3): sin esto el teclado vuelve al principio de la página. */
export function focusLater(id: string | null | undefined) {
  if (!id) return;
  let attempts = 0;
  // Si el destino sigue deshabilitado (la acción aún no ha terminado de pintarse) se reintenta unos instantes: un botón deshabilitado no recibe el foco.
  const attempt = () => {
    const target = document.getElementById(id) as (HTMLElement & { disabled?: boolean }) | null;
    if (target && !target.disabled) {
      target.focus();
      return;
    }
    attempts += 1;
    if (attempts < 30) setTimeout(attempt, 50);
  };
  requestAnimationFrame(attempt);
}

/**
 * Una acción del motor de reglas: la lanza, anuncia el resultado (aviso si salió bien, texto junto al formulario si no), mueve el foco (al titular de la página si salió bien,
 * al botón que se pulsó si no) y recarga la página con lo guardado. Si caducó el segundo factor lo dice y enlaza a pasarlo otra vez; si otra persona guardó antes (STALE) ofrece
 * recargar (el formulario se reinicia con lo guardado); un fallo inesperado nunca se queda mudo ni promete que «se puede repetir» sin comprobar.
 */
export function useRulesAction(options: { successFocusId?: string | null; failureFocusId?: string } = {}) {
  const { successFocusId = 'rules-title', failureFocusId } = options;
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<EntityActionResult | null>(null);
  const [failed, setFailed] = useState(false);

  const run = (action: () => Promise<EntityActionResult>, doneMessage: (result: EntityActionResult & { status: 'DONE' }) => string, onDone?: () => void) =>
    startTransition(async () => {
      setFailed(false);
      setOutcome(null);
      try {
        const result = await action();
        setOutcome(result);
        if (result.status === 'DONE') {
          toast({ tone: 'success', title: doneMessage(result) });
          onDone?.();
          router.refresh();
          focusLater(successFocusId);
        } else if (!(result.status === 'REJECTED' && result.fields.length > 0)) focusLater(failureFocusId); // con campos rechazados, el foco va al primero (lo hace el formulario)
      } catch {
        setFailed(true);
        focusLater(failureFocusId);
      }
    });

  return { run, pending, outcome, failed, reset: () => setOutcome(null) };
}

/** Texto de un resultado que no es «hecho»: qué ha pasado y, si toca, el enlace para volver a verificar la identidad o el botón para recargar. */
export function RulesOutcome({ outcome, failed }: { outcome: EntityActionResult | null; failed: boolean }) {
  const t = useTranslations('admin.rules');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const reload = (
    <>
      {' '}
      <button type="button" onClick={() => router.refresh()} className="inline-flex min-h-11 items-center font-bold underline">
        {t('reload')}
      </button>
    </>
  );
  if (failed) {
    return (
      <p role="alert" className="text-sm font-semibold text-red-900">
        {t('outcome.FAILED')}
        {reload}
      </p>
    );
  }
  if (!outcome || outcome.status === 'DONE') return null;
  return (
    <p role="alert" className="text-sm font-semibold text-red-900" data-testid="rules-outcome">
      {outcome.status === 'REJECTED' ? t(`reason.${outcome.reason}` as 'reason.INVALID') : t(`outcome.${outcome.status}`)}
      {outcome.status === 'REAUTH_REQUIRED' ? (
        <>
          {' '}
          <Link href={{ pathname: '/acceso/doble-factor', query: { next: localizedPath(locale, '/admin/reglas') } }} className="inline-flex min-h-11 items-center underline">
            {t('reauthLink')}
          </Link>
        </>
      ) : null}
      {outcome.status === 'REJECTED' && outcome.reason === 'STALE' ? reload : null}
    </p>
  );
}
