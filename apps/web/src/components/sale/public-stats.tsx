import { EyeOff } from "lucide-react";
import { Stat } from "@/components/ui/stat";
import { priceStr, tokenStr, usdcStr } from "@/lib/format";
import type { Sale } from "@/lib/types";

/** What anyone can read on-chain right now. Deposits yes, prices never. */
export function PublicStats({ sale }: { sale: Sale }) {
  const c = sale.config;
  // 2 columns on phones (last one full width), 3 + 2 from `sm` up. No empty cells.
  const top = "sm:col-span-2";
  const bottom = "sm:col-span-3";
  return (
    <section aria-label="Public sale stats">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-6 [&>*]:bg-elev [&>*]:px-4 [&>*]:py-3.5">
        <Stat className={top} label="Sealed bids" value={sale.bidCount.toLocaleString("en-US")} />
        <Stat className={top} label="Total deposits" value={usdcStr(sale.totalDeposits)} unit="USDC" />
        <Stat className={top} label="Floor, per token" value={priceStr(c.floorPrice)} unit="USDC" />
        <Stat className={bottom} label="Sale supply" value={tokenStr(c.saleSupply, c.decimals)} unit={c.tokenSymbol} />
        <Stat className={`col-span-2 ${bottom}`} label="Min raise" value={usdcStr(c.minRaise)} unit="USDC" />
      </div>
      <p className="mt-2.5 flex items-start gap-1.5 px-1 text-[12px] leading-snug text-subtle">
        <EyeOff className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
        Deposits are public on-chain. Max prices and max spends are sealed, and are never published.
      </p>
    </section>
  );
}
