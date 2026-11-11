import { Skeleton } from "@/components/ui/skeleton";
import { isNearMode } from "@/lib/config";

/**
 * Stands in for SaleHeader line for line: the back link, the name with its
 * status pill, the meta line, one line of description and, on the simulated
 * chain, the disclosure. Each row has the line height of the text it replaces.
 */
export function SaleHeaderSkeleton({
  back = true,
  simulatedNote = true,
}: {
  back?: boolean;
  /** Mirror of SaleHeader's `simulatedNote`. */
  simulatedNote?: boolean;
}) {
  return (
    <div>
      {back && (
        <div className="mb-2 flex h-9 items-center max-sm:h-10">
          <Skeleton className="h-3.5 w-20" rounded="sm" />
        </div>
      )}
      <div className="flex items-center gap-4">
        <div className="flex h-[1lh] items-center text-h1">
          <Skeleton className="h-[0.74lh] w-44 max-w-full" />
        </div>
        <Skeleton className="h-7 w-16" rounded="full" />
      </div>
      <div className="mt-2 flex h-[1lh] items-center text-small sm:mt-3">
        <Skeleton className="h-3 w-64 max-w-full" rounded="sm" />
      </div>
      <div className="mt-3 flex h-[1lh] items-center text-body">
        <Skeleton className="h-3.5 w-full max-w-[34rem]" rounded="sm" />
      </div>
      {simulatedNote && !isNearMode() && (
        <div className="mt-3 flex h-[1lh] items-center text-label">
          <Skeleton className="h-3 w-full max-w-[36rem]" rounded="sm" />
        </div>
      )}
    </div>
  );
}
