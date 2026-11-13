'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto de los ajustes de la plataforma con la forma de su contenido (bloques de campos). Componente de cliente: no recibe `params`. */
export default function AdminSettingsLoading() {
  return (
    <LoadingRegion className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <Skeleton className="h-9 w-2/3" />
      <SkeletonText lines={2} />
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-2xl border-2 border-varsity-navy/15 bg-white p-4">
          <Skeleton className="h-7 w-1/3" />
          <div className="mobile-stack grid gap-3 md:grid-cols-2">
            {Array.from({ length: 4 }, (_, field) => (
              <Skeleton key={field} className="h-11 w-full rounded-lg" />
            ))}
          </div>
        </div>
      ))}
    </LoadingRegion>
  );
}
