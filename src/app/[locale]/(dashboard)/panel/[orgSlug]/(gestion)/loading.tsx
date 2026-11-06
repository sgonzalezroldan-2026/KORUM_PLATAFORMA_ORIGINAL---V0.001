'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto del panel con la forma de su contenido (skill de interfaz §4). Componente de cliente: no recibe `params`. */
export default function PanelLoading() {
  return (
    <LoadingRegion className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <Skeleton className="h-9 w-2/3" />
      <div className="mobile-stack grid gap-5 md:grid-cols-2">
        <SkeletonText lines={4} />
        <SkeletonText lines={4} />
      </div>
      <SkeletonText lines={2} />
    </LoadingRegion>
  );
}
