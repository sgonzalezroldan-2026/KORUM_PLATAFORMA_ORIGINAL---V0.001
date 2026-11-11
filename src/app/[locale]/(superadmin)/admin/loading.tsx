'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto de la portada de la consola con la forma de su contenido (franja de resumen, filtros, cifras y tablas). Componente de cliente: no recibe `params`. */
export default function AdminLoading() {
  return (
    <LoadingRegion className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
      <Skeleton className="h-9 w-2/3" />
      <div className="mobile-stack grid gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
      <div className="mobile-stack grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <SkeletonText lines={6} />
      <SkeletonText lines={6} />
    </LoadingRegion>
  );
}
