'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { cleanSearchQuery, type PublicEntityHit } from '@/lib/entity-search';

/** Respuesta a una búsqueda concreta: `hits` es `null` si falló. Se guarda con su clave para ignorar respuestas de búsquedas anteriores. */
interface SearchResult {
  key: string;
  hits: PublicEntityHit[] | null;
}

const DEBOUNCE_MS = 250;
const VERTICAL_ICON: Record<PublicEntityHit['vertical'], string> = { SCHOOL: '🏫', SPORTS_CLUB: '⚽', CULTURAL: '🎭' };

/**
 * Buscador de entidades de la portada: filtra mientras se escribe (con una pausa de 250 ms) por nombre o provincia. Pide los resultados a
 * `/api/entities`, que solo devuelve entidades públicas. Si la persona no encuentra la suya, se le ofrece darla de alta. El estado de la búsqueda
 * (en reposo, buscando, con resultados, con error) se deduce de lo escrito y de la última respuesta: el efecto solo guarda respuestas.
 */
export function EntityFinder() {
  const t = useTranslations('finder');
  const inputId = useId();
  const hintId = useId();
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<SearchResult | null>(null);

  const searchable = cleanSearchQuery(query) !== null;
  const key = `${attempt}:${query}`;
  const settled = result?.key === key ? result : null;
  const status = !searchable ? 'idle' : !settled ? 'loading' : settled.hits ? 'ready' : 'error';
  const hits = settled?.hits ?? [];

  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/entities?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((response) => (response.ok ? (response.json() as Promise<{ entities: PublicEntityHit[] }>) : Promise.reject(new Error(String(response.status)))))
        .then((body) => setResult({ key, hits: body.entities }))
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === 'AbortError')) setResult({ key, hits: null });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, query, searchable]);

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={inputId} className="font-bold text-varsity-navy">
        {t('label')}
      </label>
      <input
        id={inputId}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoComplete="off"
        enterKeyHint="search"
        aria-describedby={hintId}
        placeholder={t('placeholder')}
        className="min-h-12 w-full rounded-xl border-2 border-varsity-navy bg-white px-4 text-base"
      />
      <p id={hintId} className="text-sm text-ink-soft">
        {t('hint')}
      </p>

      <div role="status" aria-live="polite" className="min-h-6 text-sm text-ink-soft">
        {status === 'loading' ? t('searching') : null}
        {status === 'ready' && hits.length > 0 ? t('results', { count: hits.length }) : null}
        {status === 'ready' && hits.length === 0 ? t('noResults') : null}
        {status === 'error' ? t('error') : null}
      </div>

      {status === 'ready' && hits.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {hits.map((hit) => (
            <li key={hit.slug}>
              <Link href={`/${hit.slug}`} className="korum-trust-vault flex min-h-14 flex-col gap-0.5 px-4 py-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="font-bold text-varsity-navy">
                  <span aria-hidden="true">{VERTICAL_ICON[hit.vertical]} </span>
                  {hit.name}
                </span>
                <span className="text-sm text-ink-soft">
                  {t(`vertical.${hit.vertical}`)}
                  {' · '}
                  {hit.city ? `${hit.city} (${hit.province})` : hit.province}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {status === 'ready' && hits.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-patio-rule-strong bg-white/80 p-4">
          <p className="font-bold text-varsity-navy">{t('emptyTitle', { query: query.trim() })}</p>
          <p className="mt-1 text-ink-soft">{t('emptyText')}</p>
          <Link href="/registro-comunidad" className="tactile-btn mt-3">
            {t('emptyAction')}
          </Link>
        </div>
      ) : null}

      {status === 'error' ? (
        <button type="button" onClick={() => setAttempt((value) => value + 1)} className="tactile-btn self-start">
          {t('retry')}
        </button>
      ) : null}
    </div>
  );
}
