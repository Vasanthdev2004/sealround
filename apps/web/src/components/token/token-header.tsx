"use client";

import { ArrowUpRight } from "lucide-react";
import { CopyButton } from "@/components/result/trade";
import { HeaderMark } from "@/components/sale-common/sale-header";
import { Tag } from "@/components/ui/badge";
import { isNearMode } from "@/lib/config";
import { accountUrl } from "@/lib/format";
import type { Sale } from "@/lib/types";

/**
 * The top of the token page: the token's face and name, its symbol with one
 * line on how it launched (`line`), and its contract id with copy and an
 * explorer link. `action` sits at the end of the title row (Share on X).
 */
export function TokenHeader({ sale, line, action }: { sale: Sale; line: React.ReactNode; action?: React.ReactNode }) {
  const c = sale.config;
  // The token contract exists once the sale's token deploy is done.
  const deployed = !sale.tokenSetup || sale.tokenSetup === "done";

  return (
    <header>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <HeaderMark sale={sale} />
          <h1 className="min-w-0 text-h1 break-words text-fg">{c.tokenName}</h1>
        </div>
        {sale.isJudgeSale && <Tag>demo run</Tag>}
        {action && <div className="ml-auto max-sm:hidden">{action}</div>}
      </div>

      <p className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-small text-subtle sm:mt-3">
        <span className="font-[510] text-fg">${c.tokenSymbol}</span>
        <span className="min-w-0">{line}</span>
      </p>

      {deployed && <ContractId sale={sale} />}
      {/* On phones the action closes the header, after what it shares. */}
      {action && <div className="mt-3 sm:hidden">{action}</div>}
    </header>
  );
}

/** The token contract id, selectable in one click, with a copy button and the explorer page (none on the mock chain). */
function ContractId({ sale }: { sale: Sale }) {
  const near = isNearMode();
  const page = near ? accountUrl(sale.tokenAccount) : "#";
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-label text-subtle">Token contract</span>
      <span className="flex min-w-0 items-center gap-1">
        <code className="min-w-0 font-mono text-label text-fg select-all [overflow-wrap:anywhere]" title={sale.tokenAccount}>
          {sale.tokenAccount}
        </code>
        <CopyButton text={sale.tokenAccount} what="token contract id" />
        {page !== "#" ? (
          <a
            href={page}
            target="_blank"
            rel="noreferrer"
            aria-label={`${sale.tokenAccount} on the explorer`}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] text-muted transition-colors hover:bg-wash hover:text-fg"
          >
            <ArrowUpRight className="size-4" strokeWidth={1.75} aria-hidden />
          </a>
        ) : (
          !near && <Tag title="The mock chain's token has no explorer page">sim</Tag>
        )}
      </span>
    </div>
  );
}
