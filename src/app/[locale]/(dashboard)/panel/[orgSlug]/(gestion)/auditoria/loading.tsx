'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto del registro de actividad de la entidad: titular, filtros y registros. Componente de cliente: no recibe `params`. */
export default function PanelAuditLoading() {
  return (
    <LoadingRegion className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
      <Skeleton className="h-9 w-1/2" />
      <SkeletonText lines={3} />
      <Skeleton className="h-16 w-full rounded-2xl" />
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-32 w-full rounded-2xl" />
      ))}
    </LoadingRegion>
  );
}
