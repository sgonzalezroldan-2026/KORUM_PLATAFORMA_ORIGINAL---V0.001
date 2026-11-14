'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link, usePathname } from '@/i18n/navigation';

/**
 * Acceso de las cabeceras: «Mi cuenta» para quien ya ha entrado e «Iniciar sesión» para el resto (deuda del 3.6). Las cabeceras viven en páginas
 * generadas una vez y compartidas entre visitantes, así que la sesión se consulta **en el navegador** (con la cookie de la persona) y nunca se
 * escribe en el HTML guardado. Mientras se consulta se muestra el acceso, que es lo que ve la mayoría.
 *
 * **Sin el cliente de Better Auth (Sprint 5.5, QA-X01):** solo hace falta saber si hay sesión, y el cliente completo (con sus dependencias) eran
 * 16 KB comprimidos en todas las páginas públicas. Basta con preguntar a `/api/auth/get-session` (sin tope de intentos: `auth-config.ts`). Se vuelve
 * a preguntar al cambiar de página, porque la cabecera no se vuelve a montar al navegar; los dos enlaces de la cabecera (escritorio y menú móvil)
 * comparten la misma consulta. Cerrar sesión recarga la página entera, así que nunca queda «Mi cuenta» de una sesión cerrada.
 */
let probe: { key: string; result: Promise<boolean> } | null = null;

function hasSession(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'session' in body && Boolean((body as { session: unknown }).session);
}

function probeSession(key: string): Promise<boolean> {
  if (probe?.key === key) return probe.result;
  const result = fetch('/api/auth/get-session', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
    .then(async (response) => (response.ok ? hasSession(await response.json()) : false))
    .catch(() => false);
  probe = { key, result };
  // Solo se comparte mientras los enlaces de la misma página se montan: volver más tarde a esta ruta (p. ej. tras iniciar sesión) pregunta de nuevo.
  void result.then(() =>
    window.setTimeout(() => {
      if (probe?.result === result) probe = null;
    }, 1_000)
  );
  return result;
}

export function AccountLink({ loginHref = '/login', className, onNavigate }: { loginHref?: string; className: string; onNavigate?: () => void }) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let active = true;
    void probeSession(pathname).then((value) => {
      if (active) setSignedIn(value);
    });
    return () => {
      active = false;
    };
  }, [pathname]);

  return (
    <Link href={signedIn ? '/mi-cuenta' : loginHref} prefetch={false} onClick={onNavigate} className={className} data-testid="header-account-link">
      {signedIn ? t('account') : t('login')}
    </Link>
  );
}
