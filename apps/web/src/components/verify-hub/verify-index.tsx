"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Search } from "lucide-react";
import { SaleStatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Empty, PageHeader, Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { TokenMark } from "@/components/ui/token-mark";
import { getClient } from "@/lib/client";
import { DocumentTitle, useClientQuery } from "@/lib/hooks";
import { VerifyEnvironment } from "./environment";
import { validVerifyId, verifyHref } from "./public-evidence";
import { TrustBoundaries } from "./trust-boundaries";
import { VerifyAllPanel } from "./verify-all-panel";

export function VerifyIndex() {
  const router = useRouter();
  const sales = useClientQuery(() => getClient().listSales(), ["verify-sales"], 0);
  const [query, setQuery] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const term = query.trim();
  const matching = sales.data?.filter((sale) => `${sale.id} ${sale.config.tokenName} ${sale.config.tokenSymbol}`.toLowerCase().includes(term.toLowerCase())) ?? [];

  return (
    <div className="flex w-full flex-col gap-8 sm:gap-10">
      <DocumentTitle title="Verify a sale" />
      <PageHeader title="Verify a sale" description="Choose a sale, run the browser checks and inspect what supports its outcome. No wallet required." />
      <VerifyEnvironment />
      <VerifyAllPanel />
      <Panel title="Find a sale" subtitle="Search this environment, or open an exact sale ID." bodyClassName="px-5 pt-3 pb-5">
        <form className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start" onSubmit={(event) => {
          event.preventDefault();
          if (!validVerifyId(term)) {
            setInputError("Use a sale ID: 1–32 lowercase letters, numbers, hyphens or underscores; start and end with a letter or number.");
            return;
          }
          router.push(verifyHref(term));
        }}>
          <Field label="Sale name, symbol or ID" placeholder="Search sales or paste an exact sale ID" value={query} maxLength={100} autoComplete="off" spellCheck={false} onChange={(event) => { setQuery(event.target.value); setInputError(null); }} error={inputError} className="min-w-0 flex-1" />
          <Button type="submit" variant="primary" className="sm:mt-[26px]" icon={<Search className="size-4" aria-hidden />} disabled={!term}>Open sale ID</Button>
        </form>
      </Panel>
      <section aria-labelledby="verify-sales-heading">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="verify-sales-heading" className="text-h3">Sales in this environment</h2>
          {!sales.loading && !sales.error && <Button variant="ghost" size="sm" onClick={sales.refetch}>Refresh sales</Button>}
        </div>
        {sales.loading ? <div className="space-y-3" aria-label="Loading sales"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div> : sales.error ? (
          <Empty title="Could not load the sale list" body="Retry the list, or use an exact sale ID above." action={<Button onClick={sales.refetch} size="sm">Retry</Button>} />
        ) : matching.length === 0 ? (
          <Empty title={term ? "No matching sales in this list" : "No sales yet"} body={term ? "If you have an exact sale ID, open it above to look it up directly." : "Sales will appear here after they are created in this environment."} />
        ) : (
          <div className="panel overflow-hidden">
            {matching.map((sale) => (
              <Link key={sale.id} href={verifyHref(sale.id)} prefetch={false} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b border-line p-4 transition-colors last:border-b-0 hover:bg-wash sm:grid-cols-[minmax(0,1fr)_11rem_10rem_auto] sm:px-5 sm:py-5">
                <div className="flex min-w-0 items-center gap-3">
                  <TokenMark symbol={sale.config.tokenSymbol} hue={sale.meta.hue} icon={sale.meta.icon} alt="" />
                  <div className="min-w-0"><h3 className="truncate text-body font-medium text-fg">{sale.config.tokenName}</h3><p className="truncate text-label text-subtle">{sale.id}</p></div>
                </div>
                <span className="hidden sm:block"><SaleStatusBadge status={sale.status} plain /></span>
                <span className="col-start-1 pl-12 text-label text-muted sm:col-auto sm:pl-0">{sale.status === "settled" || sale.status === "failed" ? "Inspect result evidence" : "Inspect sale evidence"}</span>
                <ArrowRight className="col-start-2 row-start-1 size-4 text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-accent-bright sm:col-start-4" aria-hidden />
              </Link>
            ))}
          </div>
        )}
      </section>
      <TrustBoundaries />
    </div>
  );
}
