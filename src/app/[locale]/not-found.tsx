import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';
import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/i18n/navigation';

/**
 * Título propio de la pestaña de la 404 (auditoría de experiencia del 5.5a): «404 · KORUM» en lugar del genérico de la portada. Es fijo a propósito:
 * leer el idioma aquí obliga a mirar las cabeceras de la petición, y la 404 de una ruta estática no puede hacerlo (Next responde 500). La cifra
 * no necesita traducción; el texto de la página sí sale en el idioma de la URL.
 */
export const metadata: Metadata = { title: '404' };

export default function NotFound() {
  const t = useTranslations('notFound');

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="contenido" className="mx-auto w-full max-w-2xl flex-1 px-4 py-16">
        <EmptyState
          icon="🧭"
          title={t('title')}
          description={t('description')}
          headingLevel={1}
          action={
            <Link href="/" className="tactile-btn">
              {t('backHome')}
            </Link>
          }
        />
      </main>
      <SiteFooter />
    </div>
  );
}
