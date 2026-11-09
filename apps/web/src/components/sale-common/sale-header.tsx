"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SaleStatusBadge, Tag } from "@/components/ui/badge";
import { SimulatedNote, TokenAvatar } from "@/components/ui/bits";
import { getClient } from "@/lib/client";
import { accountUrl } from "@/lib/format";
import type { Sale } from "@/lib/types";

/** Token identity row used at the top of the sale and result pages. */
export function SaleHeader({
  sale,
  actions,
  back = { href: "/", label: "All sales" },
}: {
  sale: Sale;
  actions?: React.ReactNode;
  back?: { href: string; label: string } | null;
}) {
  // Demo accounts exist only on the simulated chain, so they get no explorer link.
  const mock = getClient().mode === "mock";
  return (
    <div>
      {back && (
        <Link href={back.href} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-subtle hover:text-fg">
          <ArrowLeft className="size-3.5" /> {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <TokenAvatar symbol={sale.config.tokenSymbol} hue={sale.meta.hue} size={48} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-[22px] leading-tight font-medium tracking-[-0.02em] text-fg sm:text-[24px]">
                {sale.config.tokenName}
              </h1>
              <span className="num text-[13px] text-subtle">${sale.config.tokenSymbol}</span>
              <SaleStatusBadge status={sale.status} />
              {sale.isJudgeSale && <Tag tone="accent">judge mode</Tag>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-subtle">
              <span>
                by{" "}
                {mock ? (
                  <span className="num text-muted">{sale.creator}</span>
                ) : (
                  <a href={accountUrl(sale.creator)} target="_blank" rel="noreferrer" className="num text-muted hover:text-fg">
                    {sale.creator}
                  </a>
                )}
              </span>
              <span className="num">{sale.tokenAccount}</span>
              <span>No admin key</span>
            </div>
          </div>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {sale.meta.description && <p className="mt-4 max-w-2xl text-[14px] leading-relaxed text-muted">{sale.meta.description}</p>}
      {mock && (
        <SimulatedNote className="mt-3">
          This sale runs on a simulated chain in your browser until the contract is on testnet. Bid encryption and the
          clearing math are real; transactions, accounts and the enclave are simulated.
        </SimulatedNote>
      )}
    </div>
  );
}
