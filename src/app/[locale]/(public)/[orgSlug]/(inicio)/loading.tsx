'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto con la forma de la portada: cabecera de la entidad y una fila de tarjetas. Componente de cliente: no recibe `params`. */
export default function PortalLoading() {
  return (
    <LoadingRegion className="flex flex-col gap-6">
      <Skeleton className="h-52 w-full rounded-3xl" />
      <div className="mobile-stack grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="space-y-3 rounded-3xl border border-patio-rule-strong bg-white p-5">
            <Skeleton className="h-24 w-full" />
            <SkeletonText lines={3} />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
