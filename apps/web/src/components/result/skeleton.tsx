import { cn } from "@/lib/cn";

const Bar = ({ className }: { className?: string }) => (
  <div className={cn("shimmer rounded-lg bg-elev-2", className)} />
);

/** Loading state for the result page. Same rough shape as the real layout. */
export function ResultSkeleton() {
  return (
    <div className="mx-auto max-w-[1080px] space-y-6" aria-busy="true" aria-label="Loading result">
      <Bar className="h-4 w-28" />
      <div className="flex items-center gap-3.5">
        <div className="shimmer size-12 rounded-[28%] bg-elev-2" />
        <div className="space-y-2">
          <Bar className="h-6 w-48" />
          <Bar className="h-3.5 w-64" />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="panel space-y-5 p-5">
          <Bar className="h-3.5 w-24" />
          <Bar className="h-12 w-56" />
          <Bar className="h-1.5 w-full" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Bar key={i} className="h-12" />
            ))}
          </div>
        </div>
        <div className="panel space-y-3 p-5">
          <Bar className="h-4 w-28" />
          <Bar className="h-10 w-40" />
          <Bar className="h-24" />
          <Bar className="h-11" />
        </div>
      </div>
      <div className="panel space-y-3 p-5">
        <Bar className="h-4 w-48" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Bar className="h-24" />
          <Bar className="h-24" />
        </div>
      </div>
    </div>
  );
}
