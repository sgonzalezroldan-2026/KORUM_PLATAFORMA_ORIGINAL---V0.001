'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { authClient } from '@/lib/auth/auth-client';

/**
 * Acceso de las cabeceras: «Mi cuenta» para quien ya ha entrado e «Iniciar sesión» para el resto (deuda del 3.6). Las cabeceras viven en páginas
 * generadas una vez y compartidas entre visitantes, así que la sesión se consulta **en el navegador** (`useSession`, con la cookie de la
 * persona) y nunca se escribe en el HTML guardado. Mientras se consulta se muestra el acceso, que es lo que ve la mayoría.
 */
export function AccountLink({ loginHref = '/login', className, onNavigate }: { loginHref?: string; className: string; onNavigate?: () => void }) {
  const t = useTranslations('nav');
  const { data } = authClient.useSession();
  const signedIn = Boolean(data?.session);

  return (
    <Link href={signedIn ? '/mi-cuenta' : loginHref} prefetch={false} onClick={onNavigate} className={className} data-testid="header-account-link">
      {signedIn ? t('account') : t('login')}
    </Link>
  );
}
