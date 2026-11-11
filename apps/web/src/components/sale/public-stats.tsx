import { Stat, StatRow } from "@/components/ui/stat";
import { priceStr, tokenStr, usdcStr } from "@/lib/format";
import type { Sale, SaleResult } from "@/lib/types";

/**
 * The status panel's last row: four public numbers divided by hairlines (two
 * by two on phones). Always four cells, so the panel keeps one shape through
 * every phase. Deposits yes, individual prices never.
 *
 * `revealed` (commit-reveal, after the close) replaces the bid count with
 * "revealed of total". `result` (settled) swaps in what the clearing produced.
 */
export function PublicStats({
  sale,
  result,
  revealed,
  className,
}: {
  sale: Sale;
  result?: SaleResult | null;
  revealed?: number | null;
  className?: string;
}) {
  const c = sale.config;
  const commit = c.revealMode === "commit_reveal";
  const bids = sale.bidCount.toLocaleString("en-US");
  const deposited = <Stat label="Deposited" value={usdcStr(sale.totalDeposits)} unit="USDC" />;

  return (
    // -mb-4 takes back the cells' bottom padding, so the row ends on the panel's own padding.
    <section aria-label="Public sale numbers" className={className}>
      <StatRow flush className="-mb-4 border-t border-line">
        {sale.status === "settled" && result ? (
          <>
            <Stat label="Valid bids" value={result.nValid.toLocaleString("en-US")} unit={`of ${bids}`} />
            {deposited}
            <Stat label="Raised" value={usdcStr(result.totalRaised)} unit="USDC" />
            <Stat label="Sold" value={tokenStr(result.totalSold, c.decimals)} unit={c.tokenSymbol} />
          </>
        ) : (
          <>
            {revealed !== undefined ? (
              <Stat label="Revealed" value={revealed === null ? "–" : revealed.toLocaleString("en-US")} unit={`of ${bids}`} />
            ) : (
              <Stat label={commit ? "Committed bids" : "Sealed bids"} value={bids} />
            )}
            {deposited}
            <Stat label="Floor price" value={priceStr(c.floorPrice)} unit="USDC" />
            <Stat label="Min raise" value={usdcStr(c.minRaise)} unit="USDC" />
          </>
        )}
      </StatRow>
    </section>
  );
}
