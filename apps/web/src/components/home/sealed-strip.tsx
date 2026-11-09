import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { shortHash } from "@/lib/format";
import type { Sale, SaleStatus } from "@/lib/types";

const MAX_BARS = 28;

const BAR_TONE: Record<SaleStatus, string> = {
  upcoming: "bg-fg/20",
  open: "bg-fg/25",
  awaiting_close: "bg-fg/25",
  clearing: "bg-warn/45",
  revealing: "bg-warn/45",
  settled: "bg-ok/45",
  failed: "bg-bad/40",
};

/** FNV-1a. Deterministic "ciphertext noise" so the strip is stable across renders. */
function noise(seed: string, i: number): number {
  const s = `${seed}:${i}`;
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * One bar per sealed bid, like a strip of ciphertext. Heights are noise from
 * the sale id, never prices: nobody can see a max price, so neither can this.
 */
export function SealedStrip({ sale, className }: { sale: Sale; className?: string }) {
  const n = sale.bidCount;
  const shown = Math.min(n, MAX_BARS);
  const live = sale.status === "open";

  return (
    <div
      className={cn(
        "flex h-11 items-center gap-3 rounded-tile border border-line bg-inset px-3 shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]",
        className,
      )}
    >
      <Lock className="size-3.5 shrink-0 text-subtle" strokeWidth={1.75} aria-hidden />
      {n === 0 ? (
        <span className="min-w-0 flex-1 truncate text-[12px] text-subtle">No sealed bids yet</span>
      ) : (
        <div
          className="flex h-5 min-w-0 flex-1 items-end gap-[2px] overflow-hidden"
          role="img"
          aria-label={`${n} sealed ${n === 1 ? "bid" : "bids"}`}
          title="One bar per sealed bid. Heights are ciphertext noise, not prices."
        >
          {Array.from({ length: shown }, (_, i) => (
            <span
              key={i}
              className={cn(
                "w-[3px] shrink-0 rounded-[1px]",
                live && i === shown - 1 ? "pulse-dot bg-accent" : BAR_TONE[sale.status],
              )}
              style={{ height: `${28 + (noise(sale.id, i) % 72)}%` }}
            />
          ))}
          {n > shown && <span className="num ml-1.5 self-center text-[10.5px] text-subtle">+{n - shown}</span>}
        </div>
      )}
      <span className="cipher shrink-0" title="This sale's sealing key (X25519). Bids are encrypted to it in the browser.">
        {shortHash(sale.sealerPubkey, 4)}
      </span>
    </div>
  );
}
