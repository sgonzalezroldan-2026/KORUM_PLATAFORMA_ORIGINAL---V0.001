'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto con la forma de la ficha: dos columnas en escritorio, una en móvil. Componente de cliente: no recibe `params`. */
export default function InitiativeLoading() {
  return (
    <LoadingRegion className="flex flex-col gap-6">
      <Skeleton className="h-11 w-56" />
      <Skeleton className="h-16 w-full rounded-2xl" />
      <div className="mobile-stack grid gap-6 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-7">
          <Skeleton className="h-8 w-3/4" />
          <SkeletonText lines={5} />
        </div>
        <div className="space-y-4 lg:col-span-5">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-14 w-full rounded-2xl" />
        </div>
      </div>
    </LoadingRegion>
  );
}
