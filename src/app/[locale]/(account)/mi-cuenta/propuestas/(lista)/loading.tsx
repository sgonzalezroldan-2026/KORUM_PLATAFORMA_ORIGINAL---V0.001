'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto de «Mis propuestas y firmas»: título y tarjetas apiladas. Componente de cliente: no recibe `params`. */
export default function ProposalsLoading() {
  return (
    <LoadingRegion className="flex flex-col gap-6">
      <Skeleton className="h-10 w-72 rounded-xl" />
      {[0, 1].map((item) => (
        <div key={item} className="space-y-3 rounded-2xl border border-patio-rule-strong bg-white p-5">
          <Skeleton className="h-6 w-2/3" />
          <SkeletonText lines={4} />
        </div>
      ))}
    </LoadingRegion>
  );
}
