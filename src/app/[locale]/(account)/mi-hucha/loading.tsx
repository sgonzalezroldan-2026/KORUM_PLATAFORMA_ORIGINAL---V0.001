'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto de Mi Hucha: título, formulario de alta y tarjetas de las aportaciones. Componente de cliente: no recibe `params`. */
export default function HuchaLoading() {
  return (
    <LoadingRegion className="flex flex-col gap-6">
      <Skeleton className="h-10 w-56 rounded-xl" />
      <SkeletonText lines={2} />
      {[0, 1].map((item) => (
        <div key={item} className="space-y-3 rounded-3xl border border-patio-rule-strong bg-white p-5">
          <Skeleton className="h-6 w-1/2" />
          <SkeletonText lines={4} />
        </div>
      ))}
    </LoadingRegion>
  );
}
