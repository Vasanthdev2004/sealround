/** Loading shape of the sale page. No hooks, so the server page can use it as a fallback. */
export function SaleSkeleton() {
  return (
    <div className="mx-auto max-w-[1180px]" aria-busy="true" aria-label="Loading sale">
      <div className="shimmer mb-4 h-4 w-20 rounded-[6px] bg-elev-2" />
      <div className="flex items-center gap-3.5">
        <div className="shimmer size-12 rounded-panel bg-elev-2" />
        <div className="flex-1 space-y-2">
          <div className="shimmer h-6 w-48 max-w-full rounded-lg bg-elev-2" />
          <div className="shimmer h-3.5 w-72 max-w-full rounded-[6px] bg-elev-2" />
        </div>
      </div>
      <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <div className="shimmer h-[260px] rounded-panel bg-elev" />
          <div className="shimmer h-[84px] rounded-card bg-elev" />
          <div className="shimmer h-[380px] rounded-panel bg-elev" />
        </div>
        <div className="space-y-6">
          <div className="shimmer h-[200px] rounded-panel bg-elev" />
          <div className="shimmer h-[320px] rounded-panel bg-elev" />
        </div>
      </div>
    </div>
  );
}
