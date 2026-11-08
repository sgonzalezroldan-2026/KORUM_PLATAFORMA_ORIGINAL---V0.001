'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto de «FAQ y soporte»: título, preguntas y formulario apilados. Componente de cliente: no recibe `params`. */
export default function HelpLoading() {
  return (
    <LoadingRegion className="space-y-6">
      <Skeleton className="h-11 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-3xl" />
      {[0, 1, 2].map((item) => (
        <div key={item} className="space-y-2 rounded-2xl border border-patio-rule-strong bg-white p-4">
          <Skeleton className="h-5 w-2/3" />
          <SkeletonText lines={2} />
        </div>
      ))}
    </LoadingRegion>
  );
}
