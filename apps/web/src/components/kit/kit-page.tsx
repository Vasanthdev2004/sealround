"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { countdownPhase, type CountdownPhase } from "@/app/api/og/countdown/share";
import { HeaderMark } from "@/components/sale-common/sale-header";
import { SaleNotFound } from "@/components/sale/sale-page";
import { SaleStatusBadge } from "@/components/ui/badge";
import { SimulatedNote } from "@/components/ui/bits";
import { Button, ButtonLink } from "@/components/ui/button";
import { Empty, Panel } from "@/components/ui/panel";
import { isNearMode } from "@/lib/config";
import { networkName } from "@/lib/format";
import { DocumentTitle, useNow, useSale } from "@/lib/hooks";
import type { Sale } from "@/lib/types";
import { KitBidders } from "./kit-bidders";
import { KitImages } from "./kit-images";
import { KitLink } from "./kit-link";
import { KitPosts } from "./kit-posts";
import { KitSkeleton } from "./kit-skeleton";
import type { KitWhere } from "./kit-text";
import { KitTimes } from "./kit-times";
import { LaunchOperations } from "./operations";

/**
 * The creator's launch kit (`/sale/[id]/kit`): everything to post to bring
 * bidders in, on one page. The times in UTC and the viewer's zone, the
 * countdown image and the link preview, ready posts for X, the watch link
 * with its QR code, and what a bidder needs to know. All of it is public, so
 * the page works for anyone; its words speak to the creator, who lands here
 * right after `/create`. A settled or failed sale points at its result.
 */
export function KitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sale = useSale(id);

  if (sale.loading) return <KitSkeleton />;
  if (sale.error && !sale.data) {
    return (
      <div className="py-6">
        <DocumentTitle title="Launch workspace" />
        <Empty
          className="py-16"
          size="lg"
          titleAs="h1"
          title="Could not load this sale"
          body={sale.error.message}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={sale.refetch}>Try again</Button>
              <ButtonLink href="/sales" variant="ghost">
                All sales
              </ButtonLink>
            </div>
          }
        />
      </div>
    );
  }
  if (!sale.data) return <SaleNotFound id={id} />;
  return <KitLoaded sale={sale.data} />;
}

const LEAD: Record<Exclude<CountdownPhase, "final">, string> = {
  upcoming: "Post these before bids open. Times, images, posts for X and a QR code for the sale page, all public.",
  open: "Bids are open. Post the close time and the link while people can still get a bid in.",
  closed: "Bidding has closed. Post the reveal so your bidders watch every sealed bid open at once.",
};

function KitLoaded({ sale }: { sale: Sale }) {
  const c = sale.config;
  const now = useNow(1000);
  const phase = countdownPhase(sale.status, c.bidStart, c.bidEnd, now);
  const near = isNearMode();
  const where: KitWhere = near ? networkName() : "simulated";
  const salePath = `/sale/${encodeURIComponent(sale.id)}`;

  return (
    <div>
      <DocumentTitle title={`Launch workspace: ${c.tokenName}`} />
      <header>
        <Link
          href={salePath}
          className="mb-2 inline-flex min-h-9 items-center gap-1.5 rounded-btn text-small text-muted transition-colors duration-[120ms] hover:text-fg max-sm:min-h-10"
        >
          <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden /> The sale
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex min-w-0 items-center gap-3 sm:gap-4">
              <HeaderMark sale={sale} />
              <h1 className="min-w-0 text-h1 break-words text-fg">Launch workspace</h1>
            </div>
            <SaleStatusBadge status={sale.status} size="lg" />
          </div>
          {phase !== "final" && (
            <ButtonLink
              href={salePath}
              variant="outline"
              size="sm"
              className="max-sm:h-10"
              icon={<ArrowUpRight className="order-last size-3.5" strokeWidth={1.75} aria-hidden />}
            >
              Open the sale page
            </ButtonLink>
          )}
        </div>
        <p className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-small text-subtle sm:mt-3">
          <span className="min-w-0 break-words text-fg">{c.tokenName}</span>
          <span className="text-muted">${c.tokenSymbol}</span>
          <span className="min-w-0 break-all">by {sale.creator}</span>
        </p>
        {phase !== "final" && <p className="mt-3 max-w-[58ch] text-lead text-muted">{LEAD[phase]}</p>}
        {!near && (
          <SimulatedNote className="mt-3">
            {phase === "final" ? "Simulated sale in this browser." : "Simulated sale in this browser. The images and the posts say so."}
          </SimulatedNote>
        )}
      </header>

      <LaunchOperations sale={sale} now={now} />

      {phase === "final" ? (
        <SaleOver sale={sale} />
      ) : (
        <div className="mt-6 grid gap-4 sm:mt-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-4">
            <KitTimes sale={sale} now={now} />
            <KitImages sale={sale} phase={phase} />
            <KitPosts sale={sale} phase={phase} where={where} />
          </div>
          <aside className="flex min-w-0 flex-col gap-4" aria-label="The sale link and what bidders need">
            <KitLink sale={sale} />
            <KitBidders sale={sale} />
          </aside>
        </div>
      )}
    </div>
  );
}

/** Public destinations to share once the sale has a final result. Operations above track unfinished payouts. */
function SaleOver({ sale }: { sale: Sale }) {
  const settled = sale.status === "settled";
  const id = encodeURIComponent(sale.id);
  return (
    <Panel className="mt-6 sm:mt-8" bodyClassName="px-5 py-8 sm:px-8">
      <h2 className="text-h2 text-fg">Share the outcome</h2>
      <p className="mt-2 max-w-[58ch] text-body text-muted">
        {settled
          ? "It settled: every winner paid one clearing price. The result shows that price and every fill; the token page shows where the supply went."
          : "It did not clear, so every valid bid gets its deposit back. The result says why."}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <ButtonLink href={`/sale/${id}/result`} variant="outline" className="max-sm:h-11">
          See the result
        </ButtonLink>
        <ButtonLink href={`/token/${id}`} variant="outline" className="max-sm:h-11">
          Token page
        </ButtonLink>
      </div>
    </Panel>
  );
}
