import { cn } from "@/lib/cn";
import type { SaleStatus } from "@/lib/types";

const PHASES = [
  { key: "bid", label: "Bid" },
  { key: "close", label: "Close" },
  { key: "clear", label: "Clear" },
  { key: "claim", label: "Claim" },
] as const;

/** Index of the current phase, and whether that phase has actually started. */
function phaseOf(status: SaleStatus): { index: number; started: boolean } {
  switch (status) {
    case "upcoming":
      return { index: 0, started: false };
    case "open":
      return { index: 0, started: true };
    case "awaiting_close":
      return { index: 1, started: true };
    case "clearing":
    case "revealing":
      return { index: 2, started: true };
    case "settled":
    case "failed":
      return { index: 3, started: true };
  }
}

/**
 * The four phases of a sale as one quiet row: a rule over each name, the
 * current one in the accent (red when the sale is refunding or stalled).
 * In a commit-reveal sale the third phase is the bidders' reveal.
 */
export function PhaseTimeline({
  status,
  stalled = false,
  commit = false,
}: {
  status: SaleStatus;
  stalled?: boolean;
  commit?: boolean;
}) {
  const { index, started } = phaseOf(status);
  // Refunding, or clearing past the settle timeout: the current step turns red.
  const failed = status === "failed" || stalled;
  return (
    <ol className="grid grid-cols-4 gap-1.5" aria-label="Sale phases">
      {PHASES.map((p, i) => {
        const done = i < index;
        const current = i === index && started;
        const label = p.key === "clear" && commit ? "Reveal" : p.key === "claim" && status === "failed" ? "Refund" : p.label;
        return (
          <li
            key={p.key}
            className={cn(
              "min-w-0 border-t-2 pt-2 text-label",
              current
                ? cn("font-[510] text-fg", failed ? "border-bad" : "border-accent")
                : done
                  ? "border-subtle text-muted"
                  : "border-line-strong text-subtle",
            )}
            aria-current={current ? "step" : undefined}
          >
            {label}
            <span className="sr-only">, {done ? "done" : current ? "now" : "next"}</span>
          </li>
        );
      })}
    </ol>
  );
}
