"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { HeaderMark } from "@/components/sale-common/sale-header";
import { SaleStatusBadge, Tag } from "@/components/ui/badge";
import { getClient } from "@/lib/client";
import { accountUrl } from "@/lib/format";
import type { Sale } from "@/lib/types";

/**
 * The top of the result page: a way back, the sale's name with its state, and
 * one line of identity. The description and the rules live on the sale page.
 * `action` sits at the end of the title row (Share on X).
 */
export function ResultHeader({ sale, action }: { sale: Sale; action?: React.ReactNode }) {
  // Demo accounts exist only on the simulated chain, so they get no explorer link.
  const mock = getClient().mode === "mock";
  const c = sale.config;

  return (
    <header>
      <Link
        href={`/sale/${sale.id}`}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-btn text-small text-muted transition-colors hover:text-fg"
      >
        <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden /> Back to sale
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <HeaderMark sale={sale} />
          <h1 className="min-w-0 text-h1 break-words text-fg">{c.tokenName}</h1>
        </div>
        <SaleStatusBadge status={sale.status} size="lg" />
        {sale.isJudgeSale && <Tag>demo run</Tag>}
        {action && <div className="ml-auto max-sm:w-full">{action}</div>}
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
              className="text-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-fg"
            >
              {sale.creator}
            </a>
          )}
        </span>
        <span className="min-w-0 break-all max-sm:hidden">{sale.tokenAccount}</span>
        <span>No admin key</span>
      </p>
    </header>
  );
}
