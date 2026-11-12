'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { EntityActionResult } from '@/app/[locale]/(superadmin)/admin/entidades/actions';
import { useToast } from '@/components/ui/toast-provider';
import { Link, useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { localizedPath } from '@/lib/seo/marketing-routes';

export const BUTTON = 'min-h-11 rounded-xl px-4 font-bold disabled:opacity-60';
export const PRIMARY = `${BUTTON} bg-varsity-navy text-white hover:bg-varsity-navy-deep`;
export const OUTLINE = `${BUTTON} border-2 border-varsity-navy text-varsity-navy hover:bg-varsity-navy/5`;
export const FIELD = 'min-h-11 w-full rounded-lg border-2 border-varsity-navy/30 bg-white px-3 text-base';

/**
 * Una acción de la ficha 360º: la lanza, anuncia el resultado (aviso si salió bien, texto si no) y recarga la página con los datos nuevos. Si caducó el
 * segundo factor del Super-Admin lo dice y enlaza a pasarlo otra vez; un fallo inesperado nunca se queda mudo.
 */
export function useEntityAction() {
  const t = useTranslations('admin.org360');
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<EntityActionResult | null>(null);
  const [failed, setFailed] = useState(false);

  const run = (action: () => Promise<EntityActionResult>, doneMessage: string, onDone?: (result: EntityActionResult & { status: 'DONE' }) => void) =>
    startTransition(async () => {
      setFailed(false);
      setOutcome(null);
      try {
        const result = await action();
        setOutcome(result);
        if (result.status === 'DONE') {
          toast({ tone: 'success', title: doneMessage });
          onDone?.(result);
          router.refresh();
        }
      } catch {
        setFailed(true);
      }
    });

  const dismiss = () => {
    setOutcome(null);
    setFailed(false);
  };
  return { run, pending, outcome, failed, dismiss, t };
}

/** Texto de un resultado que no es «hecho» (con el campo que falla si lo hay) y, si toca, el enlace para volver a verificar la identidad. */
export function ActionOutcome({ outcome, failed }: { outcome: EntityActionResult | null; failed: boolean }) {
  const t = useTranslations('admin.org360');
  const locale = useLocale() as Locale;
  if (failed) {
    return (
      <p role="alert" className="text-sm font-semibold text-red-900">
        {t('outcome.FAILED')}
      </p>
    );
  }
  if (!outcome || outcome.status === 'DONE') return null;
  return (
    <p role="alert" className="text-sm font-semibold text-red-900" data-testid="entity-outcome">
      {outcome.status === 'REJECTED' ? t(`reason.${outcome.reason}` as 'reason.INVALID') : t(`outcome.${outcome.status}`)}
      {outcome.status === 'REAUTH_REQUIRED' ? (
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

/** Marco común de cada bloque de la ficha: titular accesible y, opcionalmente, una ayuda debajo. */
export function Block({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-4 flex-col gap-3 rounded-2xl border-2 border-varsity-navy/15 bg-white p-4 md:p-5" data-testid={`block-${id}`}>
      <div>
        <h2 id={`${id}-title`} className="font-corp text-xl font-extrabold text-varsity-navy">
          {title}
        </h2>
        {hint ? <p className="text-sm text-ink-soft">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}
