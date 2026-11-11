"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SaleStatusBadge, Tag } from "@/components/ui/badge";
import { SimulatedNote } from "@/components/ui/bits";
import { getClient } from "@/lib/client";
import { accountUrl } from "@/lib/format";
import type { Sale } from "@/lib/types";

/**
 * Identity and status at the top of a sale: a back link, the name with its
 * status, one meta line (ticker, creator, no admin key), and the creator's
 * description when there is one. Set like the result page's header, so the
 * two pages read as one. The layout matches SaleHeaderSkeleton line for line.
 */
export function SaleHeader({
  sale,
  actions,
  back = { href: "/", label: "All sales" },
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
          <h1 className="min-w-0 text-h1 break-words text-fg">{c.tokenName}</h1>
          <SaleStatusBadge status={sale.status} size="lg" />
          {sale.isJudgeSale && <Tag>demo run</Tag>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
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
