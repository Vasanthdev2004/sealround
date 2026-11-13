"use client";

import { Tag } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { KV } from "@/components/ui/stat";
import { isNearMode } from "@/lib/config";
import { duration, priceStr, tokenStr, usdcStr } from "@/lib/format";
import type { Sale } from "@/lib/types";

/** What a bidder needs before they come: the deposit, the floor, the window, and how sealing and funding work. Short. */
export function KitBidders({ sale }: { sale: Sale }) {
  const c = sale.config;
  const slots = sale.maxBids ?? c.maxBids;
  const tee = c.revealMode === "tee";
  return (
    <Panel title="What bidders need" bodyClassName="px-5 pb-5">
      <dl className="divide-y divide-line [&>div]:py-2.5">
        <KV k="Deposit per account" v={`${usdcStr(c.minDeposit)} to ${usdcStr(c.maxDepositPerAccount)} USDC`} />
        <KV k="Floor price" v={`${priceStr(c.floorPrice)} USDC`} />
        <KV
          k="For sale"
          v={
            <>
              {tokenStr(c.saleSupply, c.decimals)} {c.tokenSymbol}
            </>
          }
        />
        <KV k="Bids" v={slots ? `One per account, ${slots} in all` : "One per account"} mono={false} />
        <KV k="Bid window" v={duration(c.bidEnd - c.bidStart)} />
      </dl>
      <p className="mt-3 text-small text-muted">
        {tee
          ? "Bids are sealed in the bidder's browser. Nobody, the creator and bots included, sees a price or amount until the close. Every winner pays one clearing price."
          : "Bidders commit to a sealed bid and reveal it after the close. Every winner pays one clearing price."}
      </p>
      <p className="mt-2 text-small text-muted">
        No USDC on NEAR? The sale page can fund a bid from another chain through 1Click.
        {!isNearMode() && (
          <Tag className="ml-2 align-middle" title="This sale runs on the mock chain in this browser">
            sim
          </Tag>
        )}
      </p>
    </Panel>
  );
}
