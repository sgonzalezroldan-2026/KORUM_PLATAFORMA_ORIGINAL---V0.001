'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto de los logros: cabecera y dos tarjetas con su foto. Componente de cliente: no recibe `params`. */
export default function AchievementsLoading() {
  return (
    <LoadingRegion className="flex flex-col gap-6">
      <Skeleton className="h-11 w-full max-w-lg rounded-xl" />
      <Skeleton className="h-28 w-full rounded-3xl" />
      <div className="mobile-stack grid gap-6 md:grid-cols-2">
        {[0, 1].map((item) => (
          <div key={item} className="space-y-3 rounded-3xl border border-patio-rule-strong bg-white p-5">
            <Skeleton className="h-6 w-2/3" />
            <SkeletonText lines={2} />
            <Skeleton className="aspect-4/3 w-full" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
