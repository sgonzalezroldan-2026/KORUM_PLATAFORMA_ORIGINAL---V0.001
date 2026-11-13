'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto de la bandeja de soporte de KORUM: titular y tarjetas de consulta. Componente de cliente: no recibe `params`. */
export default function AdminSupportLoading() {
  return (
    <LoadingRegion className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
      <Skeleton className="h-9 w-1/2" />
      <SkeletonText lines={2} />
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-40 w-full rounded-2xl" />
      ))}
    </LoadingRegion>
  );
}
