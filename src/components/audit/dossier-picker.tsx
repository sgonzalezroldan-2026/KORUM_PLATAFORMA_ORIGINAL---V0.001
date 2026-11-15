import { getTranslations } from 'next-intl/server';
import { shortTitle } from '@/core/audit/audit-query';
import { DOSSIER_KIND_SLUGS, DOSSIER_KINDS, DOSSIER_QUERY_KEYS, type DossierKind } from '@/core/dossier/dossier-model';
import type { Locale } from '@/i18n/routing';
import { AUDIT_FIELD, AUDIT_LABEL } from './audit-filters';
import { DossierResultFocus } from './dossier-result-focus';

/**
 * Selector del expediente exportable (Sprint 5.8b), en las dos páginas de la auditoría. Formulario normal (`GET`, vuelve a la misma página): funciona sin
 * JavaScript. La página busca lo pedido y este componente enseña el resultado: el enlace de descarga del PDF, o que no se ha encontrado. Así un número mal
 * escrito no acaba en una página de error, y quien descarga ve antes de qué es el expediente.
 *
 * - **Consola:** se elige el tipo y se escribe el número (de una aportación, también su pedido de Paycomet, que es lo que trae un contracargo). Si no se
 *   encuentra, el campo conserva lo escrito y queda marcado y ligado al aviso.
 * - **Panel:** se elige de una lista con las campañas de la entidad y sus liquidaciones; no hay expediente de una aportación.
 *
 * El formulario va plegado, como los filtros, para no empujar el registro hacia abajo; se abre solo cuando hay un resultado. El formulario vuelve a la página
 * en el ancla del resultado (`#dossier-result`), que va justo debajo de la explicación, y `DossierResultFocus` lleva ahí la vista y el foco cuando el
 * resultado aparece (la página pinta antes su esqueleto de carga): queda a la vista y es lo siguiente que lee un lector de pantalla. Componente de servidor
 * (asíncrono: lee los textos con la API de servidor).
 */

export type DossierPickerResult =
  | { status: 'ready'; kind: DossierKind; id: number; initiativeId: number; title: string; href: string }
  | { status: 'notFound' }
  | { status: 'invalid' }
  | { status: 'limited' };

export interface DossierPickerOption {
  initiativeId: number;
  title: string;
  payoutId: number | null;
}

export const DOSSIER_RESULT_ID = 'dossier-result';
const HINT_ID = 'dossier-ref-hint';
/** El título de la campaña se recorta solo; el tipo y el número van siempre enteros delante. El de una liquidación, antes: su rótulo es más largo. */
const TITLE_MAX = { initiative: 44, payout: 30 } as const;

const value = (kind: DossierKind, id: number) => `${DOSSIER_KIND_SLUGS[kind]}:${id}`;

export async function DossierPicker({
  variant,
  locale,
  options = [],
  result,
  typed
}: {
  variant: 'console' | 'entity';
  locale: Locale;
  options?: readonly DossierPickerOption[];
  result: DossierPickerResult | null;
  /** Lo que se escribió en la consola, para no tener que reescribirlo si no se encontró. */
  typed?: { kindSlug: string | null; ref: string };
}) {
  const t = await getTranslations({ locale, namespace: 'audit.dossierUi' });
  const withPayout = options.filter((option) => option.payoutId !== null);
  const chosen = result?.status === 'ready' ? value(result.kind, result.id) : '';
  const failure = result === null || result.status === 'ready' ? null : result.status === 'notFound' ? (variant === 'console' ? 'notFoundConsole' : 'notFoundEntity') : result.status === 'invalid' ? (variant === 'console' ? 'invalidConsole' : 'invalidEntity') : 'limited';
  // El número no vale o no existe: el campo lo dice (no solo el aviso) y remite a él.
  const wrongReference = result?.status === 'invalid' || result?.status === 'notFound';

  return (
    <section aria-labelledby="dossier-title" className="korum-trust-vault flex flex-col gap-3 p-4" data-testid="dossier-picker">
      <h2 id="dossier-title" className="font-corp text-xl font-extrabold text-varsity-navy">
        {t('title')}
      </h2>
      <p className="text-sm text-ink-soft">{t(variant === 'console' ? 'introConsole' : 'introEntity')}</p>

      {result ? (
        <div id={DOSSIER_RESULT_ID} tabIndex={-1} role="status" className="flex scroll-mt-24 flex-col gap-2 rounded-lg bg-varsity-ivory p-3" data-testid="dossier-result" data-status={result.status}>
          {result.status === 'ready' ? (
            <>
              <p className="wrap-break-word font-semibold text-varsity-navy">{t(`ready.${result.kind}`, { id: result.id, initiativeId: result.initiativeId, title: result.title })}</p>
              <a href={result.href} className="inline-flex min-h-11 items-center self-start font-bold text-varsity-navy underline underline-offset-4" data-testid="dossier-download">
                {t('download')}
              </a>
              <p className="text-sm text-ink-soft">{t('downloadNote')}</p>
            </>
          ) : (
            <p className="font-semibold text-varsity-navy">{t(failure ?? 'limited')}</p>
          )}
          <DossierResultFocus targetId={DOSSIER_RESULT_ID} />
        </div>
      ) : null}

      {variant === 'entity' && options.length === 0 ? (
        <p className="text-ink-soft" data-testid="dossier-empty">
          {t('emptyEntity')}
        </p>
      ) : (
        <details open={result !== null} data-testid="dossier-form">
          {/* Igual que «Filtrar», justo debajo: un rótulo con su icono que se despliega, no un enlace. */}
          <summary className="inline-flex min-h-11 cursor-pointer items-center gap-2 font-corp text-lg font-extrabold text-varsity-navy">
            <span aria-hidden="true">{'📄'}</span>
            {t('open')}
          </summary>
          <form method="get" action={`#${DOSSIER_RESULT_ID}`} className="mt-3 flex flex-col gap-3">
            <div className="mobile-stack grid gap-3 md:grid-cols-2">
              {variant === 'console' ? (
                <>
                  <label className={AUDIT_LABEL}>
                    {t('kind')}
                    <select
                      name={DOSSIER_QUERY_KEYS.kind}
                      defaultValue={result?.status === 'ready' ? DOSSIER_KIND_SLUGS[result.kind] : (typed?.kindSlug ?? DOSSIER_KIND_SLUGS.initiative)}
                      className={AUDIT_FIELD}
                    >
                      {DOSSIER_KINDS.map((kind) => (
                        <option key={kind} value={DOSSIER_KIND_SLUGS[kind]}>
                          {t(`kinds.${kind}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex flex-col gap-1">
                    <label className={AUDIT_LABEL}>
                      {t('reference')}
                      <input
                        type="text"
                        name={DOSSIER_QUERY_KEYS.ref}
                        defaultValue={result?.status === 'ready' ? String(result.id) : (typed?.ref ?? '')}
                        required
                        maxLength={40}
                        autoComplete="off"
                        className={AUDIT_FIELD}
                        aria-invalid={wrongReference ? true : undefined}
                        aria-describedby={wrongReference ? `${HINT_ID} ${DOSSIER_RESULT_ID}` : HINT_ID}
                        data-testid="dossier-reference"
                      />
                    </label>
                    <p id={HINT_ID} className="text-sm text-ink-soft">
                      {t('referenceHint')}
                    </p>
                  </div>
                </>
              ) : (
                <label className={`${AUDIT_LABEL} md:col-span-2`}>
                  {t('choose')}
                  <select name={DOSSIER_QUERY_KEYS.kind} defaultValue={chosen} required className={`${AUDIT_FIELD} truncate`} aria-invalid={wrongReference ? true : undefined} aria-describedby={wrongReference ? DOSSIER_RESULT_ID : undefined}>
                    <option value="">{t('chooseNone')}</option>
                    <optgroup label={t('groupInitiatives')}>
                      {options.map((option) => (
                        <option key={option.initiativeId} value={value('initiative', option.initiativeId)} title={option.title}>
                          {t('optionInitiative', { id: option.initiativeId, title: shortTitle(option.title, TITLE_MAX.initiative) })}
                        </option>
                      ))}
                    </optgroup>
                    {withPayout.length > 0 ? (
                      <optgroup label={t('groupPayouts')}>
                        {withPayout.map((option) => (
                          <option key={option.payoutId} value={value('payout', option.payoutId!)} title={option.title}>
                            {t('optionPayout', { id: option.initiativeId, title: shortTitle(option.title, TITLE_MAX.payout) })}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </select>
                </label>
              )}
            </div>
            <div>
              <button type="submit" className="tactile-btn min-h-11 rounded-xl px-5 font-bold" data-testid="dossier-find">
                {t('find')}
              </button>
            </div>
          </form>
        </details>
      )}
    </section>
  );
}
