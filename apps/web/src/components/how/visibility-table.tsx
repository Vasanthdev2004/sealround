import { EyeOff, Eye } from "lucide-react";
import { cn } from "@/lib/cn";

type Cell = { text: string; hidden: boolean };

const ROWS: { data: string; during: Cell; after: Cell }[] = [
  {
    data: "Max price",
    during: { text: "Hidden (encrypted)", hidden: true },
    after: { text: "Never published", hidden: true },
  },
  {
    data: "Max spend",
    during: { text: "Hidden (can be lower than the deposit)", hidden: true },
    after: { text: "Never published", hidden: true },
  },
  {
    data: "Deposit amount, bidder account, bid time",
    during: { text: "Public on-chain", hidden: false },
    after: { text: "Public", hidden: false },
  },
  {
    data: "Clearing price, each fill, each refund",
    during: { text: "Not known yet", hidden: true },
    after: { text: "Public", hidden: false },
  },
  {
    data: "Anonymized demand curve",
    during: { text: "Not known yet", hidden: true },
    after: { text: "Optional, chosen at launch (planned)", hidden: true },
  },
];

function VisCell({ c }: { c: Cell }) {
  const Icon = c.hidden ? EyeOff : Eye;
  return (
    <span className={cn("inline-flex items-start gap-2", c.hidden ? "text-muted" : "text-fg")}>
      <Icon
        className={cn("mt-[3px] size-3.5 shrink-0", c.hidden ? "text-subtle" : "text-accent")}
        strokeWidth={1.75}
        aria-hidden
      />
      {c.text}
    </span>
  );
}

export function VisibilityTable() {
  return (
    <div>
      <div className="overflow-x-auto rounded-card border border-line bg-elev">
        <table className="w-full min-w-[560px] border-separate border-spacing-0 text-left text-[13px]">
          <thead>
            <tr className="text-[12px] text-subtle">
              <th className="px-4 py-3 font-normal">Data</th>
              <th className="px-4 py-3 font-normal">During the sale</th>
              <th className="px-4 py-3 font-normal">After settlement</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.data} className="[&>td]:border-t [&>td]:border-dashed [&>td]:border-line-dashed [&>td]:px-4 [&>td]:py-3 [&>td]:align-top">
                <td className="font-medium text-fg">{r.data}</td>
                <td>
                  <VisCell c={r.during} />
                </td>
                <td>
                  <VisCell c={r.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-muted">
        Bids are encrypted in your browser with a libsodium sealed box to the sale’s own key. No server stores bid
        contents; the gas relayer keeps only rate-limit counters. Individual max prices are not in the enclave’s
        output either.
      </p>
    </div>
  );
}
