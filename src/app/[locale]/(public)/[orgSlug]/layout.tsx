import clsx from 'clsx';
import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { PortalHeader } from '@/components/portal/portal-header';
import { SiteFooter } from '@/components/layout/site-footer';
import { routing } from '@/i18n/routing';
import { loadPortalOrganization } from '@/services/portal/portal-data';

// Las portadas y fichas se regeneran cada minuto: el avance de una campaña se ve casi en directo sin consultar la base en cada visita.
export const revalidate = 60;

// Ninguna entidad se genera al compilar (la base de datos no existe entonces): cada portada se genera la primera vez que alguien la pide y
// se guarda en caché. Declararlo es lo que activa esa regeneración también para las entidades dadas de alta después de la compilación.
export function generateStaticParams(): Array<{ orgSlug: string }> {
  return [];
}

/**
 * Entorno 1 · portal público de una entidad (`/[orgSlug]`). La existencia de la entidad se comprueba aquí, antes de enviar nada: una URL que no
 * es de ninguna entidad (o de una archivada) responde un `404` de verdad y no una página vacía (skill de interfaz §5). Ni el panel ni la consola
 * viven bajo este segmento: sus rutas son estáticas y tienen prioridad.
 */
export default async function PublicLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string; orgSlug: string }> }) {
  const { locale, orgSlug } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const { vertical } = await loadPortalOrganization(orgSlug);

  return (
    <div className="flex min-h-dvh flex-col">
      <PortalHeader orgSlug={orgSlug} />
      <main id="contenido" className={clsx('flex-1 px-4 py-6', vertical === 'SPORTS_CLUB' ? 'korum-court-grid' : 'korum-paper-dots')}>
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}
