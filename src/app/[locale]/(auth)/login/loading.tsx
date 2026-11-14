import { LoadingRegion, Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Esqueleto de `/login` con la forma de su tarjeta (título, selector de modo, campo y botones). Sprint 5.5b, heredado del 3.2. */
export default function LoginLoading() {
  return (
    <LoadingRegion className="mx-auto flex max-w-md flex-col gap-6 px-4 py-10">
      <div className="korum-trust-vault flex flex-col gap-4 p-6">
        <Skeleton className="h-9 w-2/3" />
        <SkeletonText lines={2} />
        <Skeleton className="h-12 w-full rounded-2xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
    </LoadingRegion>
  );
}
