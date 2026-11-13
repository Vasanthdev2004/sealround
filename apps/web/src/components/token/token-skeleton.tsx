import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

/** One text line: a bar centred in a row of the text's line height. */
function Line({ row, bar, className }: { row: string; bar: string; className?: string }) {
  return (
    <div className={cn("flex items-center", row, className)}>
      <Skeleton className={bar} rounded="sm" />
    </div>
  );
}

/**
 * Loading state for the token page, box for box with a settled token: the
 * header with Share on X, the launch block (price, trade column, four
 * figures), then the start of "Where every token went" and "How it launched".
 */
export function TokenSkeleton() {
  return (
    <LoadingRegion label="Loading the token" className="flex w-full flex-col gap-10 sm:gap-14">
      <div className="flex flex-col gap-5 sm:gap-6">
        {/* TokenHeader: mark and name with Share on X (its own row on phones), the symbol line, the contract line. */}
        <div aria-hidden>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex h-[1lh] min-w-0 items-center gap-3 text-h1 sm:gap-4">
              <Skeleton className="size-[34px] sm:size-11" rounded="tile" />
              <Skeleton className="h-[0.8lh] w-44 max-w-full" />
            </div>
            <div className="ml-auto max-sm:hidden">
              <Skeleton className="h-8 w-28" rounded="tile" />
            </div>
          </div>
          <Line row="h-[21px]" bar="h-3 w-72 max-w-full" className="mt-2 sm:mt-3" />
          <Line row="h-8" bar="h-3 w-80 max-w-full" className="mt-2" />
          <Skeleton className="mt-3 h-8 w-28 sm:hidden" rounded="tile" />
        </div>

        {/* LaunchPanel: price, the trade column, four figures. */}
        <div className="panel grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[1fr_auto]" aria-hidden>
          <div className="min-w-0 p-5 sm:p-8 lg:col-start-1 lg:row-start-1">
            <Line row="h-[18px]" bar="h-3 w-24" />
            <div className="mt-2 flex h-[1lh] items-center text-num-hero">
              <Skeleton className="h-[0.8lh] w-56 max-w-full sm:w-72" />
            </div>
            <div className="mt-4 text-body">
              <Line row="h-[1lh]" bar="h-3.5 w-full max-w-[30rem]" />
              <Line row="h-[1lh]" bar="h-3.5 w-2/5 max-w-[12rem]" />
            </div>
          </div>
          <div className="min-w-0 border-t border-line bg-bg/60 p-5 sm:p-6 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-t-0 lg:border-l">
            <Line row="h-[22px]" bar="h-4 w-28" />
            <Skeleton className="mt-3 h-11 w-full" rounded="tile" />
            <div className="mt-2.5 space-y-2">
              <Skeleton className="h-3 w-full" rounded="sm" />
              <Skeleton className="h-3 w-2/3" rounded="sm" />
            </div>
          </div>
          <div className="grid grid-cols-2 border-t border-line px-5 sm:grid-cols-4 sm:px-8 lg:col-start-1 lg:row-start-2 [&>*]:border-line [&>*]:py-4 [&>*]:pr-3 max-sm:[&>*:nth-child(even)]:border-l max-sm:[&>*:nth-child(even)]:pl-4 max-sm:[&>*:nth-child(n+3)]:border-t sm:[&>*+*]:border-l sm:[&>*+*]:pl-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i}>
                <Line row="h-[18px]" bar="h-3 w-20" />
                <div className="mt-1 flex h-[1lh] items-center text-num-md">
                  <Skeleton className="h-[0.75lh] w-24 max-w-full" />
                </div>
                <Line row="h-[18px]" bar="h-3 w-24 max-w-full" className="mt-0.5" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* SupplyStory: title, lead, then its panel. */}
      <div aria-hidden>
        <div className="flex h-[1lh] items-center text-h2">
          <Skeleton className="h-[0.75lh] w-64 max-w-full" />
        </div>
        <div className="mt-2 text-body">
          <Line row="h-[1lh]" bar="h-3.5 w-full max-w-[40rem]" />
        </div>
        <Skeleton className="mt-5 h-72 w-full" rounded="panel" />
      </div>
    </LoadingRegion>
  );
}
