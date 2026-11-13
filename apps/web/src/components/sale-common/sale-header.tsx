"use client";

import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Megaphone } from "lucide-react";
import { SaleStatusBadge, Tag } from "@/components/ui/badge";
import { SimulatedNote } from "@/components/ui/bits";
import { ButtonLink } from "@/components/ui/button";
import { TokenMark } from "@/components/ui/token-mark";
import { getClient } from "@/lib/client";
import { accountUrl } from "@/lib/format";
import { useClientQuery } from "@/lib/hooks";
import { isRhea, poolUrl } from "@/lib/liquidity";
import type { LiquidityState, Sale } from "@/lib/types";
import { useWallet } from "@/lib/wallet";

/**
 * Identity and status at the top of a sale: a back link, the name with its
 * status, one meta line (ticker, creator, no admin key), and the creator's
 * description when there is one. Set like the result page's header, so the
 * two pages read as one. The layout matches SaleHeaderSkeleton line for line.
 */
export function SaleHeader({
  sale,
  actions,
  back = { href: "/sales", label: "All sales" },
  simulatedNote = true,
}: {
  sale: Sale;
  actions?: React.ReactNode;
  back?: { href: string; label: string } | null;
  /**
   * The page's "simulated" disclosure, as the header's last line (mock chain
   * only). Pass false when the page shows it somewhere else.
   */
  simulatedNote?: boolean;
}) {
  // Demo accounts exist only on the simulated chain, so they get no explorer link.
  const mock = getClient().mode === "mock";
  const c = sale.config;
  const trade = useTradeLink(sale);
  // The creator's launch kit, while there is still a sale to promote.
  const { account } = useWallet();
  const kit = account === sale.creator && (sale.status === "upcoming" || sale.status === "open") && (
    <ButtonLink
      href={`/sale/${encodeURIComponent(sale.id)}/kit`}
      variant="outline"
      size="sm"
      icon={<Megaphone className="size-3.5" strokeWidth={1.75} aria-hidden />}
    >
      Launch kit
    </ButtonLink>
  );
  const allActions = (actions || trade || kit) && (
    <>
      {kit}
      {trade}
      {actions}
    </>
  );

  return (
    <header>
      {back && (
        <Link
          href={back.href}
          className="mb-2 inline-flex min-h-9 items-center gap-1.5 rounded-btn text-small text-muted transition-colors duration-[120ms] hover:text-fg max-sm:min-h-10"
        >
          <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden /> {back.label}
        </Link>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <HeaderMark sale={sale} />
            <h1 className="min-w-0 text-h1 break-words text-fg">{c.tokenName}</h1>
          </div>
          <SaleStatusBadge status={sale.status} size="lg" />
          {sale.isJudgeSale && <Tag>demo run</Tag>}
        </div>
        {allActions && <div className="flex flex-wrap items-center gap-2">{allActions}</div>}
      </div>

      <p className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-small text-subtle sm:mt-3">
        <span className="text-muted">${c.tokenSymbol}</span>
        <span className="min-w-0 break-all">
          by{" "}
          {mock ? (
            <span className="text-muted">{sale.creator}</span>
          ) : (
            <a
              href={accountUrl(sale.creator)}
              target="_blank"
              rel="noreferrer"
              className="text-muted underline decoration-line-strong underline-offset-2 transition-colors duration-[120ms] hover:text-fg"
            >
              {sale.creator}
            </a>
          )}
        </span>
        <span>No admin key</span>
      </p>

      {sale.meta.description && (
        <p className="mt-3 max-w-[70ch] text-body break-words text-muted">{sale.meta.description}</p>
      )}
      {mock && simulatedNote && (
        <SimulatedNote className="mt-3">
          Simulated chain, accounts and enclave, in your browser. Bid encryption and the clearing math are real.
        </SimulatedNote>
      )}
    </header>
  );
}

/**
 * The token's icon beside its name, at the height of the title's line: 34 px
 * on phones, 44 px from `sm`. Shared with the result page's header.
 */
export function HeaderMark({ sale }: { sale: Sale }) {
  const c = sale.config;
  return (
    <>
      <TokenMark symbol={c.tokenSymbol} hue={sale.meta.hue} icon={sale.meta.icon} size={34} className="sm:hidden" />
      <TokenMark symbol={c.tokenSymbol} hue={sale.meta.hue} icon={sale.meta.icon} size={44} className="max-sm:hidden" />
    </>
  );
}

/**
 * Where a settled sale's token trades, once its launch pool is seeded: the
 * pool on Rhea (`poolUrl`; another exchange's account on the explorer), or
 * "simulated" on the mock chain, whose pool id is made up and must never
 * point at the real Rhea app. Null when there is nothing to show.
 */
export function tradeTarget(
  status: Sale["status"],
  l: LiquidityState | null | undefined,
  mock: boolean,
): { kind: "link"; url: string; label: string } | { kind: "simulated" } | null {
  if (status !== "settled" || l?.stage !== "seeded") return null;
  if (mock || l.simulated) return { kind: "simulated" };
  const url = poolUrl(l.dex, l.poolId);
  return url ? { kind: "link", url, label: isRhea(l.dex) ? "Trade on Rhea" : "View the pool" } : null;
}

/** The header's trade link (see `tradeTarget`). Reads the result only once the sale has settled; the client notifies when it changes. */
function useTradeLink(sale: Sale): React.ReactNode {
  const settled = sale.status === "settled";
  const { data: result } = useClientQuery(
    () => (settled ? getClient().getResult(sale.id) : Promise.resolve(null)),
    ["sale-header:result", sale.id, settled],
    0,
  );
  const target = tradeTarget(sale.status, result?.liquidity, getClient().mode === "mock");
  if (!target) return null;
  if (target.kind === "simulated") return <Tag>Simulated Rhea pool</Tag>;
  return (
    <ButtonLink
      href={target.url}
      external
      variant="outline"
      size="sm"
      icon={<ArrowUpRight className="order-last size-3.5" strokeWidth={1.75} aria-hidden />}
    >
      {target.label}
    </ButtonLink>
  );
}
