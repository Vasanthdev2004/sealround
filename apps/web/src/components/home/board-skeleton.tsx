import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { StatRow } from "@/components/ui/stat";
import { cn } from "@/lib/cn";
import { LeaderboardSkeleton } from "./fair-leaderboard";
import { SALE_COLUMNS, SaleTableHead } from "./sale-row";

/** One counter cell: a label, a 22px value, a hint (Stat size="md"). */
function CounterSkeleton() {
  return (
    <div aria-hidden>
      <div className="flex h-[18px] items-center">
        <Skeleton className="h-3 w-20" rounded="sm" />
      </div>
      <div className="mt-1.5 flex h-[26px] items-center">
        <Skeleton className="h-5 w-14" />
      </div>
      <div className="mt-1 flex h-[18px] items-center">
        <Skeleton className="h-3 w-24" rounded="sm" />
      </div>
    </div>
  );
}

export function CountersSkeleton() {
  return (
    <StatRow>
      {Array.from({ length: 4 }, (_, i) => (
        <CounterSkeleton key={i} />
      ))}
    </StatRow>
  );
}

/** Stands in for FeaturedSale: the same two halves at the same heights. */
export function FeaturedSkeleton() {
  return (
    <div className="panel grid overflow-hidden lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]" aria-hidden>
      <div className="p-5 sm:p-8">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9" rounded="tile" />
          <div className="space-y-2">
            <Skeleton className="h-3.5 w-28" rounded="sm" />
            <Skeleton className="h-3 w-14" rounded="sm" />
          </div>
        </div>
        <div className="mt-6 sm:mt-8">
          <Skeleton className="h-3 w-16" rounded="sm" />
          <Skeleton className="mt-3 h-12 w-56 sm:h-[72px] sm:w-72" />
          <Skeleton className="mt-5 h-1 w-64 max-w-full" rounded="full" />
        </div>
        <Skeleton className="mt-5 h-11 w-44 sm:mt-6" rounded="tile" />
        <div className="mt-6 grid grid-cols-3 gap-4 border-t border-line pt-3.5 sm:mt-8">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="min-w-0 space-y-2">
              <Skeleton className="h-3 w-16 max-w-full" rounded="sm" />
              <Skeleton className="h-5 w-20 max-w-full" />
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-line lg:border-t-0 lg:border-l">
        <div className="flex h-[49px] items-center border-b border-line px-5 sm:px-6">
          <Skeleton className="h-3 w-24" rounded="sm" />
        </div>
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className={cn("flex h-11 items-center gap-3 border-b border-line px-5 sm:px-6", i >= 3 && "max-lg:hidden")}>
            <Skeleton className="h-3 w-28" rounded="sm" />
            <Skeleton className="h-5 w-24 max-sm:hidden" rounded="sm" />
            <Skeleton className="ml-auto h-3 w-16" rounded="sm" />
          </div>
        ))}
        <div className="flex h-14 items-center justify-between px-5 sm:px-6">
          <Skeleton className="h-3 w-20" rounded="sm" />
          <Skeleton className="h-3 w-14" rounded="sm" />
        </div>
      </div>
    </div>
  );
}

/** Stands in for the sales table: the same columns and row height. */
export function SaleTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="panel overflow-hidden" aria-hidden>
      <SaleTableHead />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cn(SALE_COLUMNS, "min-h-[68px] border-b border-line py-3 last:border-b-0")}>
          <div className="min-w-0 space-y-2">
            <Skeleton className="h-3.5 w-24 max-w-full" rounded="sm" />
            <Skeleton className="h-3 w-12" rounded="sm" />
          </div>
          <Skeleton className="h-6 w-20 max-sm:hidden" rounded="full" />
          <div className="space-y-2 max-sm:hidden">
            <Skeleton className="h-3.5 w-32" rounded="sm" />
            <Skeleton className="h-3 w-20" rounded="sm" />
          </div>
          <Skeleton className="h-3.5 w-8 justify-self-end max-lg:hidden" rounded="sm" />
          <Skeleton className="h-3.5 w-20 justify-self-end max-lg:hidden" rounded="sm" />
          <div className="space-y-2 justify-self-end">
            <Skeleton className="ml-auto h-3.5 w-20" rounded="sm" />
            <Skeleton className="ml-auto h-3 w-14" rounded="sm" />
          </div>
          <span />
        </div>
      ))}
    </div>
  );
}

/** The whole live part of the home page while it loads. */
export function BoardSkeleton() {
  return (
    <LoadingRegion label="Loading sales" className="flex flex-col gap-10 sm:gap-14">
      <div className="flex flex-col gap-4">
        <FeaturedSkeleton />
        <CountersSkeleton />
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex h-8 items-center">
          <Skeleton className="h-6 w-20" />
        </div>
        <SaleTableSkeleton />
      </div>
      <div className="flex flex-col gap-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-60 max-w-full" />
          <Skeleton className="h-3.5 w-80 max-w-full" rounded="sm" />
        </div>
        <LeaderboardSkeleton />
      </div>
    </LoadingRegion>
  );
}
