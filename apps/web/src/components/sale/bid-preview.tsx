"use client";

import { useEffect, useState } from "react";
import { costOf, tokensFor } from "@fairground/clearing";
import { priceStr, tokenStr, usdcStr } from "@/lib/format";
import type { Sale } from "@/lib/types";

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Keeps the second line of a row at its height while there is nothing to say. */
const BLANK = "\u00a0";

/**
 * One short sentence for screen readers, spoken once typing pauses (700 ms),
 * instead of re-reading the whole preview on every keystroke. The value shown
 * at mount is not announced.
 */
function Announce({ text }: { text: string }) {
  const [said, setSaid] = useState(text);
  useEffect(() => {
    const t = window.setTimeout(() => setSaid(text), 700);
    return () => window.clearTimeout(t);
  }, [text]);
  return (
    <p className="sr-only" aria-live="polite">
      {said}
    </p>
  );
}

/** One outcome: the case on the left, what it gives on the right, with a quieter second line. */
function Row({ k, v, sub }: { k: React.ReactNode; v: React.ReactNode; sub: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="min-w-0 text-small text-muted">{k}</dt>
      <dd className="shrink-0 text-right">
        <span className="num block text-small text-fg">{v}</span>
        <span className="num block text-label text-subtle">{sub}</span>
      </dd>
    </div>
  );
}

/**
 * What a bid can buy and what it takes from the wallet, worked out with the
 * same integer maths the enclave uses. "Up to", because bids exactly at the
 * clearing price share the remainder.
 *
 * A plain ledger inside the bid form. The same rows render before and after
 * the inputs are valid (dashes in place of numbers), so nothing jumps while
 * the user types.
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
  // Who runs the clearing maths: the enclave, or in a commit-reveal sale the contract itself.
  const clearer = c.revealMode === "commit_reveal" ? "the contract" : "the enclave";
  const one = 10n ** BigInt(c.decimals);
  const ready = maxPrice !== null && maxSpend !== null && maxPrice > 0n;

  let floor: { tokens: string; cost: string } | null = null;
  let atMax: { tokens: string; cost: string; price: string } | null = null;
  let capped = false;
  if (ready) {
    capped = c.maxPrice !== null && maxPrice > c.maxPrice;
    const eff = capped && c.maxPrice !== null ? c.maxPrice : maxPrice;
    const tFloor = min(tokensFor(maxSpend, c.floorPrice, one), c.saleSupply);
    const tMax = min(tokensFor(maxSpend, eff, one), c.saleSupply);
    floor = { tokens: tokenStr(tFloor, c.decimals), cost: usdcStr(costOf(tFloor, c.floorPrice, one)) };
    atMax = { tokens: tokenStr(tMax, c.decimals), cost: usdcStr(costOf(tMax, eff, one)), price: priceStr(eff) };
  }
  const extra = deposit !== null && maxSpend !== null && deposit > maxSpend ? deposit - maxSpend : 0n;

  return (
    <div>
      <h3 className="text-small font-[510] text-fg">What you could get</h3>
      <Announce
        text={
          floor
            ? `At the floor price, up to ${floor.tokens} ${sym} for ${floor.cost} USDC.`
            : "Enter a max price and max spend to see what you could get."
        }
      />
      <dl className="mt-1.5 divide-y divide-line border-b border-line">
        <Row
          k={
            <>
              Clears at the floor, <span className="num">{priceStr(c.floorPrice)}</span>
            </>
          }
          v={floor ? `up to ${floor.tokens} ${sym}` : "–"}
          sub={floor ? `for ${floor.cost} USDC` : BLANK}
        />
        <Row
          k={
            <>
              Clears at your max
              {atMax && (
                <>
                  , <span className="num">{atMax.price}</span>
                </>
              )}
            </>
          }
          v={atMax ? `up to ${atMax.tokens} ${sym}` : "–"}
          sub={atMax ? `for ${atMax.cost} USDC` : BLANK}
        />
        <Row k="Clears above your max" v="No tokens" sub="full refund" />
        <Row
          k="Leaves your wallet now"
          v={deposit !== null ? `${usdcStr(deposit)} USDC` : "–"}
          sub={extra > 0n ? `at least ${usdcStr(extra)} USDC returns` : "your deposit"}
        />
      </dl>
      {capped && (
        <p className="mt-2 text-label text-warn">
          Above this sale&apos;s max price, so {clearer} caps your bid at it.
        </p>
      )}
      <p className="mt-2 text-label text-subtle">
        Exact, by the same integer maths as {clearer}. You never pay above your max price or your max spend.
      </p>
    </div>
  );
}
