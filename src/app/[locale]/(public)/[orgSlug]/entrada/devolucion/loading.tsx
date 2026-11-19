'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/**
 * Esqueleto de la devolución tras un cambio de fecha (Sprint 5.13): título, las dos fechas con el importe y el botón. Componente de cliente: no recibe
 * `params`. Un enlace que no sirve enseña su propio aviso (no es un 404), y la entidad y el idioma inexistentes los rechazan antes los `layout` del portal, que se
 * resuelven antes del esqueleto: no cambia ningún código de respuesta.
 */
export default function EventRefundLoading() {
  return (
    <LoadingRegion className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-8">
      <Skeleton className="h-10 w-3/4" />
      <SkeletonText lines={2} />
      <div className="space-y-3 rounded-2xl border-2 border-varsity-navy bg-white p-4">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-7 w-1/3" />
      </div>
      <Skeleton className="h-12 w-full rounded-2xl" />
    </LoadingRegion>
  );
}
