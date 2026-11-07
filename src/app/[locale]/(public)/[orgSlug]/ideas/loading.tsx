'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto del buzón: cabecera y una fila de hojas de cuaderno. Componente de cliente: no recibe `params`. */
export default function IdeasLoading() {
  return (
    <LoadingRegion className="flex flex-col gap-6">
      <Skeleton className="h-11 w-full max-w-lg rounded-xl" />
      <Skeleton className="h-40 w-full rounded-3xl" />
      <div className="mobile-stack grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="space-y-3 rounded-3xl border border-patio-rule-strong bg-white p-5">
            <Skeleton className="h-6 w-2/3" />
            <SkeletonText lines={3} />
            <Skeleton className="h-3 w-full rounded-full" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
