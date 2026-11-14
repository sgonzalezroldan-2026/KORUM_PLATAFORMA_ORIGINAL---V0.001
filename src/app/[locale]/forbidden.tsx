import { useTranslations } from 'next-intl';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';
import { DocumentTitle } from '@/components/ui/document-title';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';

const secondaryAction =
  'inline-flex min-h-11 items-center justify-center rounded-xl border-2 border-varsity-navy px-4 font-semibold text-varsity-navy hover:bg-varsity-navy/10 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * 403 de los entornos privados (`forbidden()` en las guardias): la sesión es válida pero no tiene permiso para esta entidad o esta consola. Ofrece ir al sitio
 * de la persona (`/acceso/continuar` la lleva a su panel, a su consola o a *Mi cuenta*), entrar con otra cuenta o cerrar la sesión (Sprint 5.5b, heredado del 3.2).
 */
export default function Forbidden() {
  const t = useTranslations('forbidden');

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Título propio de la pestaña (WCAG 2.4.2): sin esto quedaba el de la página pedida («Consola · KORUM»). */}
      <DocumentTitle title={`${t('title')} · KORUM`} />
      <SiteHeader />
      <main id="contenido" className="mx-auto w-full max-w-2xl flex-1 px-4 py-16">
        <EmptyState
          icon="🔒"
          title={t('title')}
          description={t('description')}
          headingLevel={1}
          action={
            <div className="mobile-stack flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
              <Link href="/acceso/continuar" className="tactile-btn justify-center">
                {t('goToMyPanel')}
              </Link>
              <Link href="/login" className={secondaryAction}>
                {t('switchAccount')}
              </Link>
              <SignOutButton className={secondaryAction} />
            </div>
          }
        />
      </main>
      <SiteFooter />
    </div>
  );
}
