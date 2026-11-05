'use client';

import { useTranslations } from 'next-intl';
import { useId, useSyncExternalStore } from 'react';
import { CONSENT_STORAGE_KEY, type CookieConsent, type NonEssentialCookie } from '@/config/cookies';

/** Evento propio para avisar a los demás componentes de la misma página cuando la decisión cambia (`storage` solo salta entre pestañas). */
const CONSENT_EVENT = 'korum:cookie-consent';

/** Lo que dice este navegador: la decisión guardada, `none` si todavía no ha elegido (o no deja guardar) o `pending` en el servidor. */
type ConsentSnapshot = CookieConsent | 'none' | 'pending';

function readConsent(): ConsentSnapshot {
  try {
    const stored = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return stored === 'granted' || stored === 'denied' ? stored : 'none';
  } catch {
    return 'none';
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener(CONSENT_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CONSENT_EVENT, onChange);
  };
}

/**
 * Aviso de cookies no esenciales. Se monta solo si hay alguna registrada en `NON_ESSENTIAL_COOKIES`; sin ellas no existe ni se descarga.
 * «Aceptar» y «Rechazar» son botones idénticos en tamaño y énfasis (CUMPLIMIENTO §6), y rechazar es el resultado de no elegir nada:
 * ningún script de seguimiento debe leer `granted` en `CONSENT_STORAGE_KEY` antes de que la persona lo pulse.
 */
export function CookieNotice({ cookies }: { cookies: readonly NonEssentialCookie[] }) {
  const t = useTranslations('cookies');
  const titleId = useId();
  // En el servidor y durante la hidratación vale `pending` (no se pinta nada): quien ya eligió no ve parpadear el aviso.
  const consent = useSyncExternalStore<ConsentSnapshot>(subscribe, readConsent, () => 'pending');

  if (cookies.length === 0 || consent !== 'none') return null;

  function decide(value: CookieConsent) {
    try {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, value);
    } catch {
      // Sin almacenamiento la decisión no se puede recordar: el aviso volverá a salir en la siguiente visita.
    }
    window.dispatchEvent(new Event(CONSENT_EVENT));
  }

  const buttonClass = 'inline-flex min-h-11 min-w-32 items-center justify-center rounded-lg border-2 border-varsity-navy bg-white px-4 font-bold text-varsity-navy hover:bg-varsity-navy/10';

  return (
    <section aria-labelledby={titleId} className="fixed inset-x-0 bottom-0 z-50 border-t-2 border-varsity-navy bg-white p-4 shadow-vault">
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        <h2 id={titleId} className="font-corp text-lg font-extrabold text-varsity-navy">
          {t('title')}
        </h2>
        <p>{t('text')}</p>
        <ul className="list-disc ps-6 text-sm text-ink-soft">
          {cookies.map((cookie) => (
            <li key={cookie.name}>
              <strong>{cookie.name}</strong>
              {' · '}
              {cookie.provider}
              {' · '}
              {t(`purposes.${cookie.purpose}`)}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={buttonClass} onClick={() => decide('denied')}>
            {t('reject')}
          </button>
          <button type="button" className={buttonClass} onClick={() => decide('granted')}>
            {t('accept')}
          </button>
        </div>
      </div>
    </section>
  );
}
