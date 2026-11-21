'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto de *Mi cuenta › Privacidad y acceso* (Sprint 5.10b): título y bloques apilados, como la página principal. Componente de cliente: no recibe `params`. */
export default function AccountLoading() {
  return (
    <LoadingRegion className="flex flex-col gap-6">
      <Skeleton className="h-10 w-64 rounded-xl" />
      <Skeleton className="h-11 w-full rounded-xl" />
      {[0, 1, 2].map((item) => (
        <div key={item} className="space-y-3 rounded-3xl border border-patio-rule-strong bg-white p-5">
          <Skeleton className="h-6 w-1/2" />
          <SkeletonText lines={3} />
        </div>
      ))}
    </LoadingRegion>
  );
}
