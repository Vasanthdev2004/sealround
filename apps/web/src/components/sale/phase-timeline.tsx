import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SaleStatus } from "@/lib/types";

const PHASES = [
  { key: "bid", label: "Bid", sub: "Sealed in your browser" },
  { key: "close", label: "Close", sub: "Anyone can call it" },
  { key: "clear", label: "Clear", sub: "Enclave, one price" },
  { key: "claim", label: "Claim", sub: "Tokens and refunds" },
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

/** Bid -> Close -> Clear -> Claim, with the current phase highlighted. */
export function PhaseTimeline({ status }: { status: SaleStatus }) {
  const { index, started } = phaseOf(status);
  const failed = status === "failed";
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Sale phases">
      {PHASES.map((p, i) => {
        const done = i < index;
        const current = i === index && started;
        const sub = p.key === "claim" && failed ? "Full refunds" : p.sub;
        return (
          <li key={p.key} className="min-w-0" aria-current={current ? "step" : undefined}>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "relative flex size-5 shrink-0 items-center justify-center rounded-full ring-1",
                  done && "bg-ok-soft ring-ok/30",
                  current && (failed ? "bg-bad-soft ring-bad/40" : "bg-accent-soft ring-accent/50"),
                  !done && !current && "bg-inset ring-line-strong",
                )}
              >
                {done ? (
                  <Check className="size-3 text-ok" strokeWidth={2.5} />
                ) : current ? (
                  <span className={cn("pulse-dot size-2 rounded-full", failed ? "bg-bad" : "bg-accent")} />
                ) : (
                  <span className="num text-[10px] text-subtle">{i + 1}</span>
                )}
              </span>
              {i < PHASES.length - 1 && (
                <span
                  aria-hidden
                  className={cn("h-px min-w-2 flex-1 border-t", done ? "border-ok/40" : "rule-dashed")}
                />
              )}
            </div>
            <div className={cn("mt-2 text-[12.5px] font-medium", current ? "text-fg" : done ? "text-muted" : "text-subtle")}>
              {p.label}
            </div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-subtle">{sub}</div>
          </li>
        );
      })}
    </ol>
  );
}
