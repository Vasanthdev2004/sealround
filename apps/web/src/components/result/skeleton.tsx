import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { isNearMode } from "@/lib/config";

/** One text line: a bar centred in a row of the text's line height. */
function Line({ row, bar, className }: { row: string; bar: string; className?: string }) {
  return (
    <div className={cn("flex items-center", row, className)}>
      <Skeleton className={bar} rounded="sm" />
    </div>
  );
}

/** One lane of the fairness timeline: the marks sit on a line across it. */
function Lane({ className }: { className: string }) {
  return (
    <div className={cn("flex items-center", className)}>
      <Skeleton className="h-1.5 w-full" rounded="full" />
    </div>
  );
}

/**
 * Loading state for the result page, box for box with the settled layout: the
 * header, the outcome block with "Your result" beside it and the reveal band
 * under its headline, the fairness timeline, the same-price comparison, then
 * the start of "Where every token went".
 * Heights follow a typical settled sale of about 50 bids at 1440 and 375 px.
 */
export function ResultSkeleton() {
  return (
    <LoadingRegion label="Loading the result" className="flex w-full flex-col gap-10 sm:gap-14">
      <div className="flex flex-col gap-5 sm:gap-6">
        {/* ResultHeader: back link, name and status with Share on X (its own row on phones), one meta line. */}
        <div aria-hidden>
          <Line row="h-9" bar="h-3.5 w-24" />
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex h-[1lh] min-w-0 items-center gap-4 text-h1">
              <Skeleton className="h-[0.8lh] w-44 max-w-full" />
              <Skeleton className="h-7 w-20" rounded="full" />
            </div>
            <div className="ml-auto max-sm:w-full">
              <Skeleton className="h-8 w-28" rounded="tile" />
            </div>
          </div>
          <Line row="h-[21px]" bar="h-3 w-72 max-w-full sm:w-[28rem]" className="mt-2 sm:mt-3" />
        </div>

        <div className="flex flex-col gap-4">
          {/* OutcomeHero: headline, your result, the reveal band, four facts, one quiet line. */}
          <div
            className="panel grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[1fr_auto_auto_auto]"
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

            <div className="min-w-0 border-t border-line bg-bg/60 p-5 sm:p-6 lg:col-start-2 lg:row-span-4 lg:row-start-1 lg:border-t-0 lg:border-l">
              <Line row="h-[22px]" bar="h-4 w-24" />
              <Line row="h-[18px]" bar="h-3 w-32" className="mt-0.5" />
              <div className="mt-4 space-y-2">
                <Skeleton className="h-3.5 w-full" rounded="sm" />
                <Skeleton className="h-3.5 w-2/3" rounded="sm" />
              </div>
              <Skeleton className="mt-5 h-11 w-full" rounded="tile" />
            </div>

            {/* OutcomeReveal: a title row with Replay, then four steps, two by two on phones. */}
            <div className="min-w-0 border-t border-line lg:col-start-1">
              <div className="flex min-h-11 items-center justify-between gap-3 px-5 pt-2 sm:px-8">
                <Line row="h-[1lh] text-label" bar="h-3 w-44 max-w-full" />
                <Line row="h-8" bar="h-3 w-12" />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 [&>*]:min-w-0 [&>*]:border-line max-sm:[&>*:nth-child(even)]:border-l max-sm:[&>*:nth-child(n+3)]:border-t sm:[&>*+*]:border-l">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="px-5 pt-2 pb-4 sm:px-6 sm:first:pl-8">
                    <div className="flex h-6 items-center">
                      <Skeleton className="h-1.5 w-full max-w-[132px]" rounded="full" />
                    </div>
                    {/* The step's title, often two lines, then its detail (wide screens only). */}
                    <div className="mt-2 text-small">
                      <Line row="h-[1lh]" bar="h-3.5 w-full max-w-[9rem]" />
                      <Line row="h-[1lh]" bar="h-3.5 w-3/5 max-w-[6rem]" />
                    </div>
                    <Line row="h-[1lh] text-label" bar="h-3 w-4/5 max-w-[10rem]" className="mt-0.5 max-sm:hidden" />
                  </div>
                ))}
              </div>
            </div>

            <div className="grid min-w-0 grid-cols-2 border-t border-line [&>*]:border-line max-sm:[&>*:nth-child(even)]:border-l max-sm:[&>*:nth-child(n+3)]:border-t sm:grid-cols-4 sm:[&>*+*]:border-l lg:col-start-1">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="min-w-0 px-5 py-4 sm:px-6 sm:first:pl-8">
                  <Line row="h-[18px]" bar="h-3 w-20 max-w-full" />
                  <Line row="h-[1lh] text-num-md" bar="h-5 w-16 max-w-full" className="mt-1" />
                </div>
              ))}
            </div>

            {/* Who cleared the bids, the penalties, the settle tx: one row on wide screens, wrapping to
                two on tablets and three on phones, as the text does. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-line px-5 py-3 text-label sm:px-8 lg:col-start-1">
              <Line row="h-[1lh]" bar="h-3 w-56 max-w-full" />
              <Line row="h-[1lh]" bar="h-3 w-60 max-w-full" />
              <Line row="h-5" bar="h-3 w-48 max-w-full" className="sm:ml-auto" />
            </div>
          </div>
          {/* The simulated-chain note, two lines on narrow screens. */}
          {!isNearMode() && (
            <div className="text-label" aria-hidden>
              <Line row="h-[1lh]" bar="h-3 w-80 max-w-full" />
              <Line row="h-[1lh] md:hidden" bar="h-3 w-40" />
            </div>
          )}
        </div>
      </div>

      {/* FairnessTimeline: a section title, the lead, then the chart card: legend, the winners' lane with
          its labels, the second lane, the axis and the table toggle. */}
      <div aria-hidden>
        <Line row="h-[30px]" bar="h-6 w-64 max-w-full" />
        <div className="mt-2 max-w-[68ch] text-body">
          <Line row="h-[1lh]" bar="h-3.5 w-full" />
          <Line row="h-[1lh]" bar="h-3.5 w-full sm:w-2/5" />
          <Line row="h-[1lh] sm:hidden" bar="h-3.5 w-1/2" />
        </div>
        <div className="panel mt-5 px-5 pt-4 pb-5 sm:px-6 sm:pt-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-label">
            {["w-10", "w-16", "w-20", "w-12", "w-28"].map((w) => (
              <Line key={w} row="h-[1lh]" bar={cn("h-3", w)} />
            ))}
          </div>
          <div className="mt-5">
            <div className="flex flex-wrap items-center justify-between gap-x-4 text-label">
              <Line row="h-[1lh]" bar="h-3 w-28" />
              <Line row="h-[1lh]" bar="h-3 w-56 max-w-full" />
            </div>
            <Lane className="h-[54px] sm:h-[47px]" />
            <Line row="h-5" bar="h-3 w-28" />
            <Line row="h-[1lh] text-label" bar="h-3 w-24" className="mt-3" />
            <Lane className="h-[38px] sm:h-[47px]" />
            <div className="mt-1 flex h-5 items-center justify-between">
              <Skeleton className="h-3 w-9" rounded="sm" />
              <Skeleton className="h-3 w-9" rounded="sm" />
            </div>
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <Line row="h-8" bar="h-3.5 w-40" />
          </div>
        </div>
      </div>

      {/* SamePrice: a section title over two columns, a row of facts and the verdict. On phones each
          price's unit, each column's detail and the first fact's unit take a line of their own. */}
      <div aria-hidden>
        <Line row="h-[30px]" bar="h-6 w-72 max-w-full" />
        <div className="mt-5 grid grid-cols-2 border-t border-line">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className={cn("min-w-0 pt-5 pb-6", i === 0 ? "pr-4 sm:pr-8" : "border-l border-line pl-4 sm:pl-8")}>
              <Line row="h-[18px]" bar="h-3 w-20" />
              <Line row="h-[31px] sm:h-10" bar="h-6 w-24 sm:h-8 sm:w-32" className="mt-2" />
              <Line row="h-[1lh] text-label" bar="h-3 w-20" className="mt-0.5 sm:hidden" />
              <div className="mt-2.5 text-small">
                <Line row="h-[1lh]" bar="h-3 w-full max-w-[14rem]" />
                <Line row="h-[1lh] sm:hidden" bar="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
        <div className="h-px bg-line" />
        <div className="grid grid-cols-3 border-b border-line [&>*]:min-w-0 [&>*]:pt-6 [&>*]:pr-3 [&>*]:pb-4 [&>*+*]:border-l [&>*+*]:border-line [&>*+*]:pl-3 sm:[&>*+*]:pl-5">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i}>
              <Line row="h-[18px]" bar="h-3 w-20 max-w-full" />
              <Line row="h-[1lh] text-num-md" bar="h-5 w-14 max-w-full" className="mt-1" />
              {i === 0 && <Line row="h-[1lh] text-label" bar="h-3 w-14 max-w-full" className="sm:hidden" />}
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-start gap-3">
          <Skeleton className="mt-1 size-4 shrink-0" rounded="full" />
          <div className="min-w-0 flex-1">
            <Line row="h-[1lh] text-body" bar="h-3.5 w-80 max-w-full" />
            <div className="mt-0.5 text-label">
              <Line row="h-[1lh]" bar="h-3 w-96 max-w-full" />
              <Line row="h-[1lh] sm:hidden" bar="h-3 w-24" />
            </div>
          </div>
        </div>
      </div>

      {/* SupplyStory: a section title, the lead, then the card: supply at launch and after, the
          segmented bar, the ledger's header and rows. The mint and burn log sits below the fold. */}
      <div aria-hidden>
        <Line row="h-[30px]" bar="h-6 w-60 max-w-full" />
        <div className="mt-2 max-w-[68ch] text-body">
          <Line row="h-[1lh]" bar="h-3.5 w-full" />
          <Line row="h-[1lh]" bar="h-3.5 w-3/5" />
        </div>
        <div className="panel mt-5">
          <div className="px-5 pt-5 sm:px-6">
            <div className="grid gap-3 sm:grid-cols-2 sm:gap-0 [&>*+*]:border-line max-sm:[&>*+*]:border-t max-sm:[&>*+*]:pt-3 sm:[&>*+*]:border-l sm:[&>*+*]:pl-6">
              {Array.from({ length: 2 }, (_, i) => (
                <div key={i} className="min-w-0 sm:pr-4">
                  <Line row="h-[18px]" bar="h-3 w-24 max-w-full" />
                  <Line row="h-[1lh] text-num-md" bar="h-5 w-32 max-w-full" className="mt-1" />
                </div>
              ))}
            </div>
            <Skeleton className="mt-5 h-7 w-full" rounded="sm" />
          </div>
          <div className="mt-5 border-t border-line">
            <div className="flex h-9 items-center justify-between border-b border-line px-5 sm:px-6">
              <Skeleton className="h-3 w-10" rounded="sm" />
              <Skeleton className="h-3 w-24" rounded="sm" />
            </div>
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-start justify-between gap-4 border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
                <div className="min-w-0 flex-1">
                  <Line row="h-[21px]" bar="h-3.5 w-32" />
                  <Line row="h-[18px]" bar="h-3 w-full max-w-[22rem]" className="mt-0.5" />
                </div>
                <Line row="h-[21px]" bar="h-3.5 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
