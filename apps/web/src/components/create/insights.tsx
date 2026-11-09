"use client";

import { Panel } from "@/components/ui/panel";
import { Stat } from "@/components/ui/stat";
import { tokenStr, usdcStr } from "@/lib/format";
import { Note } from "./form-kit";
import { pctStr, type Derived } from "./model";

const count = (n: bigint) => n.toLocaleString("en-US");

/** Live numbers that follow from the price, supply and limits above. */
export function Insights({ derived }: { derived: Derived }) {
  const { insights: i, values: v } = derived;
  const cap = v.maxDeposit !== undefined ? `${usdcStr(v.maxDeposit)} USDC` : null;

  return (
    <Panel title="What these numbers mean" subtitle="Updates as you type. Nothing here is a forecast of demand.">
      <div className="@container flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line @[40rem]:grid-cols-4 [&>*]:bg-elev [&>*]:px-4 [&>*]:py-3.5">
          <Stat
            label="Sell-out at the floor"
            value={i.raiseAtFloor !== null ? usdcStr(i.raiseAtFloor) : "—"}
            unit="USDC"
            hint="Raise if every token sells at the floor."
          />
          <Stat
            label="Most it can raise"
            value={v.ceiling === null ? "No cap" : i.maxRaise !== null ? usdcStr(i.maxRaise) : "—"}
            unit={v.ceiling === null ? undefined : "USDC"}
            hint={v.ceiling === null ? "Grows with the clearing price." : "Sale supply × max price."}
          />
          <Stat
            label="Fewest bidders to succeed"
            value={i.biddersToSucceed !== null ? count(i.biddersToSucceed) : "—"}
            hint={cap ? `To reach the minimum raise at ${cap} each.` : "Set the deposit cap."}
          />
          <Stat
            label="Bidders to sell out"
            value={i.biddersToSellOut !== null ? count(i.biddersToSellOut) : "—"}
            hint={cap ? `At the floor, ${cap} each.` : "Set the deposit cap."}
          />
        </div>

        {i.perAccountTokens !== null && i.perAccountBps !== null && (
          <p className="text-[13px] leading-relaxed text-muted">
            One account can buy at most{" "}
            <span className="num text-fg">{tokenStr(i.perAccountTokens)}</span> tokens at the floor,{" "}
            <span className="num text-fg">{pctStr(i.perAccountBps)}</span> of the sale. If demand pushes the price
            up, the same deposit buys fewer.
          </p>
        )}

        {i.impossible && (
          <Note tone="bad">
            This sale can never succeed: the minimum raise is above sale supply × max price, so every bidder would be
            refunded. Lower the minimum raise or raise the max price.
          </Note>
        )}
      </div>
    </Panel>
  );
}
