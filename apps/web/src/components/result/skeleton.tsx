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
 * Loading state for the result page, box for box with the settled layout: the
 * header, the outcome block with "Your result" beside it, then the same-price
 * comparison.
 */
export function ResultSkeleton() {
  return (
    <LoadingRegion label="Loading the result" className="flex w-full flex-col gap-10 sm:gap-14">
      <div className="flex flex-col gap-5 sm:gap-6">
        {/* ResultHeader: back link, name and status, one meta line. */}
        <div aria-hidden>
          <Line row="h-9" bar="h-3.5 w-24" />
          <div className="mt-2 flex h-[1lh] items-center gap-4 text-h1">
            <Skeleton className="h-[0.8lh] w-44 max-w-full" />
            <Skeleton className="h-7 w-20" rounded="full" />
          </div>
          <Line row="h-[21px]" bar="h-3 w-72 max-w-full sm:w-[28rem]" className="mt-2 sm:mt-3" />
        </div>

        <div className="flex flex-col gap-4">
          {/* OutcomeHero: headline, your result, four facts, one quiet line. */}
          <div
            className="panel grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[1fr_auto_auto]"
            aria-hidden
          >
            <div className="min-w-0 p-5 sm:p-8 lg:col-start-1">
              <Line row="h-[18px]" bar="h-3 w-24" />
              <div className="mt-2 flex h-[1lh] items-center text-num-hero">
                <Skeleton className="h-[0.8lh] w-56 max-w-full sm:w-72" />
              </div>
              <Line row="h-[21px]" bar="h-3 w-48" className="mt-3" />
              <div className="mt-4 text-body sm:mt-5">
                <Line row="h-[1lh]" bar="h-3.5 w-full max-w-[30rem]" />
                <Line row="h-[1lh]" bar="h-3.5 w-2/5 max-w-[12rem]" />
              </div>
              <Skeleton className="mt-5 h-1 w-full sm:mt-6" rounded="full" />
              <Line row="h-[21px]" bar="h-3 w-52" className="mt-2.5" />
            </div>

            <div className="min-w-0 border-t border-line bg-bg/60 p-5 sm:p-6 lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:border-t-0 lg:border-l">
              <Line row="h-[22px]" bar="h-4 w-24" />
              <Line row="h-[18px]" bar="h-3 w-32" className="mt-0.5" />
              <div className="mt-4 space-y-2">
                <Skeleton className="h-3.5 w-full" rounded="sm" />
                <Skeleton className="h-3.5 w-2/3" rounded="sm" />
              </div>
              <Skeleton className="mt-5 h-11 w-full" rounded="tile" />
            </div>

            <div className="grid min-w-0 grid-cols-2 border-t border-line [&>*]:border-line max-sm:[&>*:nth-child(even)]:border-l max-sm:[&>*:nth-child(n+3)]:border-t sm:grid-cols-4 sm:[&>*+*]:border-l lg:col-start-1">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="min-w-0 px-5 py-4 sm:px-6 sm:first:pl-8">
                  <Line row="h-[18px]" bar="h-3 w-20 max-w-full" />
                  <Line row="h-[1lh] text-num-md" bar="h-5 w-16 max-w-full" className="mt-1" />
                </div>
              ))}
            </div>

            <div className="flex min-w-0 items-center border-t border-line px-5 py-3 sm:px-8 lg:col-start-1">
              <Line row="h-5" bar="h-3 w-64 max-w-full" />
            </div>
          </div>
          <Line row="h-[18px]" bar="h-3 w-80 max-w-full" />
        </div>
      </div>

      {/* SamePrice: a section title over two columns and a row of facts. */}
      <div aria-hidden>
        <Line row="h-[30px]" bar="h-6 w-72 max-w-full" />
        <div className="mt-5 grid grid-cols-2 border-t border-line">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className={cn("min-w-0 pt-5 pb-6", i === 0 ? "pr-4 sm:pr-8" : "border-l border-line pl-4 sm:pl-8")}>
              <Line row="h-[18px]" bar="h-3 w-20" />
              <Line row="h-[31px] sm:h-10" bar="h-6 w-24 sm:h-8 sm:w-32" className="mt-2" />
              <Line row="h-[21px]" bar="h-3 w-full max-w-[14rem]" className="mt-2.5" />
            </div>
          ))}
        </div>
        <div className="h-px bg-line" />
        <div className="grid grid-cols-3 border-b border-line [&>*]:min-w-0 [&>*]:pt-6 [&>*]:pr-3 [&>*]:pb-4 [&>*+*]:border-l [&>*+*]:border-line [&>*+*]:pl-3 sm:[&>*+*]:pl-5">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i}>
              <Line row="h-[18px]" bar="h-3 w-20 max-w-full" />
              <Line row="h-[1lh] text-num-md" bar="h-5 w-14 max-w-full" className="mt-1" />
            </div>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}
