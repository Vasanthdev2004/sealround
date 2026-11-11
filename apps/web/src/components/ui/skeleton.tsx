import { cn } from "@/lib/cn";

/**
 * A loading block: faint base plus the shimmer sweep. Size it exactly like the
 * content it stands in for (same height, same radius) so nothing shifts when
 * data lands. Text lines: use the line-height of the text (e.g. h-[13px] for
 * 13px labels sits in a 18px row; wrap it in a div with that row height).
 */
export function Skeleton({ className, rounded = "md" }: { className?: string; rounded?: "sm" | "md" | "full" | "tile" | "panel" }) {
  const r = { sm: "rounded", md: "rounded-md", full: "rounded-full", tile: "rounded-tile", panel: "rounded-panel" }[rounded];
  return (
    <div className={cn("relative overflow-hidden bg-wash", r, className)} aria-hidden>
      <div className="shimmer absolute inset-0" />
    </div>
  );
}

/** A labelled region that is loading: announces "Loading" once to screen readers. */
export function LoadingRegion({
  label = "Loading",
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
