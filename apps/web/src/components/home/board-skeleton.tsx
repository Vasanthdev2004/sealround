import { cn } from "@/lib/cn";
import { StatRow } from "@/components/ui/stat";

/** A skeleton block: faint base plus the shimmer sweep on top. */
export function Sk({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded bg-white/[0.04]", className)} aria-hidden>
      <div className="shimmer absolute inset-0" />
    </div>
  );
}

/** Placeholder for one counter cell. */
export function CounterSkeleton() {
  return (
    <div aria-hidden>
      <Sk className="h-3 w-20" />
      <Sk className="mt-2.5 h-[30px] w-16 rounded-md" />
      <Sk className="mt-2 h-3 w-24" />
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="flex flex-col gap-4 rounded-panel border border-line bg-elev p-4" aria-hidden>
      <div className="flex items-center gap-3">
        <Sk className="size-10 rounded-[28%]" />
        <div className="flex-1">
          <Sk className="h-3.5 w-28" />
          <Sk className="mt-2 h-3 w-40" />
        </div>
        <Sk className="h-[22px] w-16 rounded-full" />
      </div>
      <Sk className="h-11 rounded-tile" />
      <div>
        <Sk className="h-3 w-20" />
        <Sk className="mt-2 h-[22px] w-28" />
      </div>
      <div className="border-t border-dashed border-line-dashed pt-3">
        <Sk className="h-3 w-48" />
      </div>
    </div>
  );
}

export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

/** Suspense fallback for the whole sales board. */
export function BoardSkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-busy="true" aria-label="Loading sales">
      <StatRow>
        {Array.from({ length: 4 }, (_, i) => (
          <CounterSkeleton key={i} />
        ))}
      </StatRow>
      <div className="flex flex-col gap-4">
        <Sk className="h-5 w-24" />
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: 7 }, (_, i) => (
            <Sk key={i} className="h-8 w-20 rounded-full" />
          ))}
        </div>
        <CardGridSkeleton />
      </div>
    </div>
  );
}
