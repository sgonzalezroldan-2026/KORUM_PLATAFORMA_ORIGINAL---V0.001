'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto del visor de la auditoría: titular, buscador, filtros y registros. Componente de cliente: no recibe `params`. */
export default function AdminAuditLoading() {
  return (
    <LoadingRegion className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
      <Skeleton className="h-9 w-1/2" />
      <SkeletonText lines={2} />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <Skeleton className="h-16 w-full rounded-2xl" />
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-36 w-full rounded-2xl" />
      ))}
    </LoadingRegion>
  );
}
