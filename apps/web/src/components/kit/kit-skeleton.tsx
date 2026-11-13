import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";

/** Stands in for the launch kit: the header, then the two columns of panels at their usual heights. */
export function KitSkeleton() {
  return (
    <LoadingRegion label="Loading the launch kit">
      <div className="mb-2 flex h-9 items-center max-sm:h-10">
        <Skeleton className="h-3.5 w-28" rounded="sm" />
      </div>
      <div className="flex items-center gap-3 sm:gap-4">
        <Skeleton className="size-[34px] sm:size-11" rounded="tile" />
        <div className="flex h-[1lh] items-center text-h1">
          <Skeleton className="h-[0.74lh] w-64 max-w-full" />
        </div>
      </div>
      <div className="mt-2 flex h-[1lh] items-center text-small sm:mt-3">
        <Skeleton className="h-3 w-56 max-w-full" rounded="sm" />
      </div>
      <div className="mt-3 flex h-[1lh] items-center text-lead">
        <Skeleton className="h-3.5 w-full max-w-[34rem]" rounded="sm" />
      </div>
      <div className="mt-6 grid gap-4 sm:mt-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="h-[236px]" rounded="panel" />
          <Skeleton className="h-[360px]" rounded="panel" />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="h-[420px]" rounded="panel" />
        </div>
      </div>
    </LoadingRegion>
  );
}
