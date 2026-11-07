'use client';

import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto de la lista de certificados y justificantes. En su grupo `(lista)`: la hoja de cada donación decide su 404 antes de enviar nada. */
export default function DocumentsLoading() {
  return (
    <LoadingRegion className="flex flex-col gap-6">
      <Skeleton className="h-10 w-72 rounded-xl" />
      {[0, 1].map((item) => (
        <div key={item} className="space-y-3 rounded-3xl border border-patio-rule-strong bg-white p-5">
          <Skeleton className="h-6 w-24" />
          <SkeletonText lines={2} />
        </div>
      ))}
    </LoadingRegion>
  );
}
