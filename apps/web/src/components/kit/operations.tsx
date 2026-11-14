"use client";

import Link from "next/link";
import { ArrowUpRight, Check } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useResult } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import type { Sale } from "@/lib/types";
import { launchOperation } from "./operations-model";

const PHASES = [["setup", "Set up"], ["bidding", "Collect bids"], ["settlement", "Settle"], ["distribution", "Distribute"]] as const;

export function LaunchOperations({ sale, now }: { sale: Sale; now: number }) {
  const result = useResult(sale.id);
  const { account } = useWallet();
  const operation = launchOperation(sale, result.data, now);
  const current = PHASES.findIndex(([id]) => id === operation.phase);
  const id = encodeURIComponent(sale.id);
  const links = [
    ["Sale", `/sale/${id}`], ["Result", `/sale/${id}/result`], ["Token", `/token/${id}`],
    ["Verify", `/verify/${id}`], ["Your activity", "/activity"],
  ];
  return (
    <section aria-labelledby="operations-title" className="panel mt-6 overflow-hidden sm:mt-8">
      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-10">
        <div className="min-w-0">
          <h2 id="operations-title" className="text-h2 text-fg">{operation.title}</h2>
          <p className="mt-2 max-w-[65ch] text-small text-muted">{operation.body}</p>
          <ButtonLink href={operation.href} variant="primary" className="mt-5 max-sm:w-full" icon={<ArrowUpRight className="order-last size-4" aria-hidden />}>{operation.action}</ButtonLink>
          {result.error && <div className="mt-3 text-small text-muted" role="status">
            Result details could not refresh. Open the result before acting.
            <Button size="sm" variant="ghost" className="ml-1 max-sm:min-h-11" onClick={result.refetch}>Retry</Button>
          </div>}
        </div>
        <div className="min-w-0 border-t border-line pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
          <p className="text-label font-[510] text-fg">Who can act</p>
          <p className="mt-2 text-small text-muted [overflow-wrap:anywhere]">{operation.permission}</p>
          <p className="mt-3 text-label text-subtle [overflow-wrap:anywhere]">{account === sale.creator ? "Connected as the creator" : `Creator: ${sale.creator}`}</p>
        </div>
      </div>
      <ol aria-label="Launch progress" className="grid grid-cols-2 border-t border-line px-5 sm:grid-cols-4 sm:px-6">
        {PHASES.map(([key, label], index) => <li key={key} aria-current={index === current ? "step" : undefined} className="flex min-h-12 items-center gap-2 pr-2 text-small">
          {index < current ? <Check className="size-3.5 shrink-0 text-muted" aria-hidden /> : <span className={cn("num w-3.5 shrink-0", index === current ? "text-accent" : "text-subtle")}>{index + 1}</span>}
          <span className={index === current ? "font-[510] text-fg" : "text-muted"}>{label}</span>
        </li>)}
      </ol>
      <nav aria-label="Launch workspace links" className="flex flex-wrap gap-x-5 border-t border-line px-5 py-2 sm:px-6">
        {links.map(([label, href]) => <Link key={href} href={href} className="inline-flex min-h-10 items-center gap-1 rounded-sm text-small text-muted transition-colors hover:text-fg">{label}<ArrowUpRight className="size-3.5" aria-hidden /></Link>)}
      </nav>
    </section>
  );
}
