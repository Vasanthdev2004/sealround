"use client";

import { share, shareStr } from "@/components/result/supply";
import { TradeAction } from "@/components/result/trade";
import { Tag } from "@/components/ui/badge";
import { priceStr, tokenFull, usdcStr } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";
import type { TokenFigures } from "./figures";

/**
 * The token page's first block: the launch price every winner paid (with the
 * pool's opening price when a pool is seeded), the way to trade, and four
 * figures: supply, burn, holders and raise. Laid out like the result page's
 * outcome block; on phones the trade action comes right after the price.
 */
export function LaunchPanel({ sale, result, figures: f }: { sale: Sale; result: SaleResult; figures: TokenFigures }) {
  const c = sale.config;
  const sym = c.tokenSymbol;
  const d = c.decimals;
  const l = result.liquidity;
  const total = f.ledger.total;

  return (
    <section
      className="panel grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[1fr_auto]"
      aria-labelledby="launch-price-title"
    >
      <div className="min-w-0 p-5 sm:p-8 lg:col-start-1 lg:row-start-1">
        <h2 id="launch-price-title" className="text-label text-subtle">
          Launch price
        </h2>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="num min-w-0 text-num-hero text-fg [overflow-wrap:anywhere]">{priceStr(f.launchPrice)}</span>
          <span className="text-body text-muted">USDC per {sym}</span>
        </div>
        <p className="mt-4 max-w-[56ch] text-body text-muted">
          {f.holders === 1 ? (
            <span className="text-fg">The clearing price the sale&rsquo;s one winner paid.</span>
          ) : (
            <>
              <span className="text-fg">The one price all {f.holders} winners paid</span>, bots included, however early or
              late they bid.
            </>
          )}
        </p>
        {f.poolPrice !== null && (
          <p className="mt-3 text-small text-muted">
            Pool opened at <span className="num text-fg">{priceStr(f.poolPrice)} USDC</span>
            {f.poolPrice === f.launchPrice && ", the launch price"}
            {l?.simulated && (
              <Tag title="No exchange was called on the mock chain" className="ml-2 align-[1px]">
                sim
              </Tag>
            )}
          </p>
        )}
      </div>

      <div
        id="launch-pool"
        className="min-w-0 scroll-mt-20 border-t border-line bg-bg/60 p-5 sm:p-6 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-t-0 lg:border-l"
      >
        <h2 className="text-h3 text-fg">Trade {sym}</h2>
        <TradeAction sale={sale} result={result} className="mt-3" />
        <p className="mt-4 border-t border-line pt-4 text-label text-subtle">
          Any NEAR wallet shows NEP-141 tokens. Some need the token contract id added by hand.
        </p>
      </div>

      <dl className="grid grid-cols-2 border-t border-line px-5 sm:grid-cols-4 sm:px-8 lg:col-start-1 lg:row-start-2 [&>*]:min-w-0 [&>*]:border-line [&>*]:py-4 [&>*]:pr-3 max-sm:[&>*:nth-child(even)]:border-l max-sm:[&>*:nth-child(even)]:pl-4 max-sm:[&>*:nth-child(n+3)]:border-t sm:[&>*+*]:border-l sm:[&>*+*]:pl-5">
        <Figure
          label={f.supply.label}
          value={tokenFull(f.supply.value, d)}
          unit={sym}
          hint={f.burn.value > 0n && !f.burn.done && f.supply.label === "Supply now" ? "Before the burn" : undefined}
        />
        <Figure
          label={f.burn.label}
          value={tokenFull(f.burn.value, d)}
          unit={sym}
          hint={f.burn.value > 0n ? `${shareStr(share(f.burn.value, total))} of the launch supply` : "Every token sold"}
        />
        <Figure label="Holders at launch" value={f.holders.toLocaleString("en-US")} hint="The sale's winners" />
        <Figure label="Raised" value={usdcStr(f.raised)} unit="USDC" />
      </dl>
    </section>
  );
}

function Figure({ label, value, unit, hint }: { label: string; value: string; unit?: string; hint?: string }) {
  return (
    <div>
      <dt className="text-label text-subtle">{label}</dt>
      <dd className="num mt-1 flex flex-wrap items-baseline gap-x-1.5 text-num-md text-fg">
        <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
        {unit && <span className="text-label font-normal tracking-normal text-muted">{unit}</span>}
      </dd>
      {hint && <dd className="mt-0.5 text-label text-subtle">{hint}</dd>}
    </div>
  );
}
