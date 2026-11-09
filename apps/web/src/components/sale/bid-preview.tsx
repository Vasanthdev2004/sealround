import { costOf, tokensFor } from "@fairground/clearing";
import { priceStr, tokenStr, usdcStr } from "@/lib/format";
import type { Sale } from "@/lib/types";

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * What a bid can buy, worked out with the same integer maths the enclave uses.
 * "Up to", because bids exactly at the clearing price share the remainder.
 */
export function BidPreview({
  sale,
  maxPrice,
  maxSpend,
  deposit,
}: {
  sale: Sale;
  maxPrice: bigint | null;
  maxSpend: bigint | null;
  deposit: bigint | null;
}) {
  const c = sale.config;
  const sym = c.tokenSymbol;
  const one = 10n ** BigInt(c.decimals);
  const ready = maxPrice !== null && maxSpend !== null && maxPrice > 0n;

  let rows: { label: React.ReactNode; tokens: string | null; cost: string | null }[] = [];
  if (ready) {
    const eff = c.maxPrice !== null && maxPrice > c.maxPrice ? c.maxPrice : maxPrice;
    const atFloor = min(tokensFor(maxSpend, c.floorPrice, one), c.saleSupply);
    const atMax = min(tokensFor(maxSpend, eff, one), c.saleSupply);
    rows = [
      {
        label: (
          <>
            Clears at the floor, <span className="num">{priceStr(c.floorPrice)}</span> USDC
          </>
        ),
        tokens: tokenStr(atFloor, c.decimals),
        cost: usdcStr(costOf(atFloor, c.floorPrice, one)),
      },
      {
        label: (
          <>
            Clears at your max price, <span className="num">{priceStr(eff)}</span> USDC
          </>
        ),
        tokens: tokenStr(atMax, c.decimals),
        cost: usdcStr(costOf(atMax, eff, one)),
      },
      { label: "Clears above your max price", tokens: null, cost: null },
    ];
  }
  const extra = deposit !== null && maxSpend !== null && deposit > maxSpend ? deposit - maxSpend : 0n;

  return (
    <div className="inset flex flex-col p-4" aria-live="polite">
      <div className="text-[12px] text-subtle">What you could get</div>
      {ready ? (
        <ul className="mt-2 divide-y divide-dashed divide-line-dashed">
          {rows.map((r, i) => (
            <li key={i} className="py-2.5 first:pt-1">
              <div className="text-[12px] text-muted">{r.label}</div>
              {r.tokens !== null ? (
                <div className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="num text-[18px] tracking-[-0.02em] text-fg">
                    up to {r.tokens} <span className="font-sans text-[12px] text-muted">{sym}</span>
                  </span>
                  <span className="num text-[12px] text-subtle">for {r.cost} USDC</span>
                </div>
              ) : (
                <div className="mt-0.5 text-[14px] text-fg">No tokens. Full refund.</div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="hatch mt-2 flex min-h-[132px] flex-1 items-center justify-center rounded-lg border border-dashed border-line-dashed px-4 py-6 text-center text-[12.5px] text-subtle">
          Enter a max price and max spend to see what you could get at the floor and at your max price.
        </div>
      )}
      <div className="mt-auto pt-3 text-[12.5px] leading-snug text-muted">
        You never pay more than your max price per token, and never more than your max spend.
        {extra > 0n && (
          <>
            {" "}
            The other <span className="num text-fg">{usdcStr(extra)} USDC</span> of your deposit comes back in full.
          </>
        )}
      </div>
    </div>
  );
}
