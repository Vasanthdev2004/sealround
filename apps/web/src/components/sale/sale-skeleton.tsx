import { SaleHeaderSkeleton } from "@/components/sale-common/sale-header-skeleton";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { StatRow } from "@/components/ui/stat";
import { isNearMode } from "@/lib/config";

/** A card header: the 16px title in its 51px bar. */
function CardHead({ w = "w-28", aside }: { w?: string; aside?: boolean }) {
  return (
    <div className="flex h-[51px] items-center justify-between border-b border-line px-5">
      <Skeleton className={`h-3.5 ${w}`} rounded="sm" />
      {aside && <Skeleton className="h-3 w-20" rounded="sm" />}
    </div>
  );
}

/** Ledger rows: label left, value right, 41px each, hairlines between. */
function Ledger({ rows }: { rows: number }) {
  return (
    <div className="px-5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-[41px] items-center justify-between border-b border-line last:border-b-0">
          <Skeleton className="h-3 w-24" rounded="sm" />
          <Skeleton className="h-3 w-16" rounded="sm" />
        </div>
      ))}
    </div>
  );
}

/** A Field: 13px label, 40px input, and optionally the row of chips under it. */
function FieldSkeleton({ chips = false, hint = false, aside = false }: { chips?: boolean; hint?: boolean; aside?: boolean }) {
  return (
    <div>
      <div className={`flex items-center justify-between ${aside ? "h-6" : "h-[18px]"}`}>
        <Skeleton className="h-3 w-20" rounded="sm" />
        {aside && <Skeleton className="h-3 w-24" rounded="sm" />}
      </div>
      <Skeleton className="mt-1.5 h-10" rounded="tile" />
      {hint && (
        <div className="mt-1.5 flex h-[18px] items-center">
          <Skeleton className="h-3 w-48 max-w-full" rounded="sm" />
        </div>
      )}
      {chips && (
        <div className="mt-2 flex gap-1.5">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-[72px] max-sm:h-10" rounded="tile" />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Loading shape of the sale page while a sale is open: the header, the status
 * panel (phase row, label, countdown, bar, button, four numbers), the bid
 * form and the bids ledger in the main column, and the funding, money and
 * rules cards in the side column. Same grid as SaleLoaded. Used as the server
 * fallback too.
 */
export function SaleSkeleton() {
  return (
    <LoadingRegion label="Loading sale">
      <SaleHeaderSkeleton simulatedNote={false} />

      <div className="mt-5 grid gap-4 sm:mt-6 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* Status panel */}
          <div className="panel overflow-hidden">
            <div className="p-5 sm:p-8">
              <div className="grid grid-cols-4 gap-1.5">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="border-t-2 border-line-strong pt-2">
                    <div className="flex h-[18px] items-center">
                      <Skeleton className="h-3 w-9" rounded="sm" />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-6 sm:mt-8">
                <div className="flex h-[18px] items-center">
                  <Skeleton className="h-3 w-16" rounded="sm" />
                </div>
                <div className="mt-2 flex h-[1lh] items-center text-num-hero max-[359px]:text-num-xl">
                  <Skeleton className="h-[0.8lh] w-[4.6em] max-w-full" />
                </div>
                <div className="mt-5 flex h-[18px] items-center gap-3">
                  <Skeleton className="h-1 max-w-[280px] flex-1" rounded="full" />
                  <Skeleton className="h-3 w-40" rounded="sm" />
                </div>
                <Skeleton className="mt-5 h-11 w-[168px] max-sm:w-full sm:mt-6" rounded="tile" />
              </div>
              <StatRow flush className="mt-6 -mb-4 border-t border-line sm:mt-8">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i}>
                    <div className="flex h-[18px] items-center">
                      <Skeleton className="h-3 w-16" rounded="sm" />
                    </div>
                    <div className="mt-1.5 flex h-[26px] items-center">
                      <Skeleton className="h-5 w-20 max-w-full" />
                    </div>
                  </div>
                ))}
              </StatRow>
            </div>
            {!isNearMode() && (
              <div className="flex h-[43px] items-center border-t border-line px-5 sm:px-8">
                <Skeleton className="h-3 w-full max-w-[34rem]" rounded="sm" />
              </div>
            )}
          </div>

          {/* Bid form: three fields, the preview ledger, the action row */}
          <div className="panel overflow-hidden">
            <CardHead w="w-36" aside />
            <div className="p-5">
              <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
                <div className="flex flex-col gap-5">
                  <FieldSkeleton chips hint />
                  <FieldSkeleton chips />
                  <FieldSkeleton hint aside />
                </div>
                <div className="border-t border-line pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-8">
                  <div className="flex h-[21px] items-center">
                    <Skeleton className="h-3 w-32" rounded="sm" />
                  </div>
                  <div className="mt-1.5">
                    {Array.from({ length: 4 }, (_, i) => (
                      <div key={i} className="flex h-[60px] items-center justify-between border-b border-line">
                        <Skeleton className="h-3 w-32" rounded="sm" />
                        <Skeleton className="h-3 w-20" rounded="sm" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-5 flex flex-col gap-x-5 gap-y-3 border-t border-line pt-5 sm:flex-row sm:items-center">
                <Skeleton className="h-11 w-[176px] shrink-0 max-sm:w-full" rounded="tile" />
                <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                  <Skeleton className="h-3 w-full max-w-[26rem]" rounded="sm" />
                  <Skeleton className="h-3 w-full max-w-[30rem]" rounded="sm" />
                </div>
              </div>
            </div>
          </div>

          {/* Public bids */}
          <div className="panel overflow-hidden">
            <div className="flex h-[71px] flex-col justify-center gap-2 border-b border-line px-5">
              <Skeleton className="h-3.5 w-24" rounded="sm" />
              <Skeleton className="h-3 w-72 max-w-full" rounded="sm" />
            </div>
            <div className="h-9 border-b border-line max-sm:hidden" />
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex h-11 items-center gap-4 border-b border-line px-5 last:border-b-0 max-sm:h-[69px]">
                <Skeleton className="h-3 w-36" rounded="sm" />
                <Skeleton className="h-5 w-24 max-sm:hidden" rounded="sm" />
                <Skeleton className="ml-auto h-3 w-16" rounded="sm" />
              </div>
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {/* Fund from any chain */}
          <div className="panel overflow-hidden">
            <div className="flex h-[71px] flex-col justify-center gap-2 border-b border-line px-5">
              <Skeleton className="h-3.5 w-36" rounded="sm" />
              <Skeleton className="h-3 w-52 max-w-full" rounded="sm" />
            </div>
            <div className="flex flex-col gap-5 p-5">
              <div>
                <div className="flex h-[18px] items-center">
                  <Skeleton className="h-3 w-14" rounded="sm" />
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {["w-14", "w-20", "w-20", "w-16", "w-16"].map((w, i) => (
                    <Skeleton key={i} className={`h-8 max-sm:h-10 ${w}`} rounded="full" />
                  ))}
                </div>
              </div>
              <FieldSkeleton chips />
              <div className="flex h-[38px] items-end border-t border-line">
                <Skeleton className="h-3 w-56 max-w-full" rounded="sm" />
              </div>
              <div className="flex h-4 items-center">
                <Skeleton className="h-3 w-32" rounded="sm" />
              </div>
              <div>
                <div className="flex h-[18px] items-center">
                  <Skeleton className="h-3 w-28" rounded="sm" />
                </div>
                <div className="mt-1.5 flex gap-1">
                  <Skeleton className="h-8 w-28 max-sm:h-10" rounded="full" />
                  <Skeleton className="h-8 w-20 max-sm:h-10" rounded="full" />
                </div>
              </div>
              <Skeleton className="h-9 max-sm:h-10" rounded="tile" />
            </div>
          </div>

          {/* Where's my money */}
          <div className="panel overflow-hidden">
            <CardHead w="w-32" />
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex h-[63px] flex-col justify-center gap-2.5 border-b border-line px-5 last:border-b-0">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-28" rounded="sm" />
                  <Skeleton className="h-3 w-16" rounded="sm" />
                </div>
                <Skeleton className="h-3 w-40" rounded="sm" />
              </div>
            ))}
          </div>

          {/* Rules */}
          <div className="panel overflow-hidden">
            <CardHead w="w-12" aside />
            <Ledger rows={9} />
            <div className="flex h-12 items-center border-t border-line px-5">
              <Skeleton className="h-3 w-40" rounded="sm" />
            </div>
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
