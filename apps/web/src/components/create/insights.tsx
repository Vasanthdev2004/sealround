"use client";

import { Stat, StatRow } from "@/components/ui/stat";
import { tokenStr, usdcStr } from "@/lib/format";
import { pctStr, type Derived } from "./model";

const count = (n: bigint) => n.toLocaleString("en-US");

/** What the price, supply and limits above add up to. Arithmetic, not a forecast. */
export function Insights({ derived }: { derived: Derived }) {
  const { insights: i, values: v } = derived;
  const capped = v.maxDeposit !== undefined;
  // The limits section already says this, as a warning, when one account could take half the sale.
  const warned = derived.notices.some((n) => n.id === "whale");

  return (
    <section aria-label="What these numbers add up to" className="flex flex-col gap-3">
      <StatRow>
        <Stat
          label="Raise at the floor"
          value={i.raiseAtFloor !== null ? usdcStr(i.raiseAtFloor, 6) : "–"}
          unit="USDC"
          hint="If every token sells"
        />
        <Stat
          label="Most it can raise"
          value={v.ceiling === null ? "No cap" : i.maxRaise !== null ? usdcStr(i.maxRaise, 6) : "–"}
          unit={v.ceiling === null ? undefined : "USDC"}
          hint={v.ceiling === null ? "Grows with the price" : "Supply × max price"}
        />
        <Stat
          label="Bidders to succeed"
          value={i.biddersToSucceed !== null ? count(i.biddersToSucceed) : "–"}
          hint={capped ? "Each at the deposit cap" : "Set the deposit cap"}
        />
        <Stat
          label="Bidders to sell out"
          value={i.biddersToSellOut !== null ? count(i.biddersToSellOut) : "–"}
          hint={capped ? "At the floor and the cap" : "Set the deposit cap"}
        />
      </StatRow>

      <p className="max-w-[68ch] text-small text-muted">
        {!warned && i.perAccountTokens !== null && i.perAccountBps !== null && (
          <>
            One account can buy at most <span className="num text-fg">{tokenStr(i.perAccountTokens)}</span> tokens at
            the floor, <span className="num text-fg">{pctStr(i.perAccountBps)}</span> of the sale.{" "}
          </>
        )}
        Arithmetic from your numbers, not a forecast of demand.
      </p>
    </section>
  );
}
