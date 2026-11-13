"use client";

import { use, useState } from "react";
import { BidSetPanel } from "@/components/result/bid-inclusion";
import { effectiveFills } from "@/components/result/compute";
import { EventLog } from "@/components/sale-common/event-log";
import { SaleHeader } from "@/components/sale-common/sale-header";
import { WheresMyMoney } from "@/components/sale-common/wheres-my-money";
import { Button, ButtonLink } from "@/components/ui/button";
import { Empty } from "@/components/ui/panel";
import { useLatestFunding } from "@/lib/funding";
import { getClient } from "@/lib/client";
import { isNearMode } from "@/lib/config";
import { DocumentTitle, useBalances, useClientQuery, useMyBid, useSale } from "@/lib/hooks";
import type { Sale } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { BidForm } from "./bid-form";
import { BidTable } from "./bid-table";
import { FundPanel } from "./fund-panel";
import { MyBidCard } from "./my-bid-card";
import { RulesPanel } from "./rules-panel";
import { SaleSkeleton } from "./sale-skeleton";
import { StatusPanel } from "./status-panel";

export function SalePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sale = useSale(id);

  if (sale.loading) return <SaleSkeleton />;
  if (sale.error && !sale.data) {
    return (
      <div className="py-6">
        <DocumentTitle title="Sale" />
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
  return <SaleLoaded key={sale.data.id} sale={sale.data} />;
}

/** Shared by the sale and result pages: an unknown id, explained, with a way on. */
export function SaleNotFound({ id }: { id: string }) {
  return (
    <div className="py-6">
      <DocumentTitle title="Sale not found" />
      <Empty
        className="py-16"
        size="lg"
        titleAs="h1"
        title={
          <>
            No sale called <span className="num [overflow-wrap:anywhere]">{id}</span>
          </>
        }
        body={
          isNearMode()
            ? "The contract has no sale with this id. Check the link, or pick a sale from the list."
            : "This demo keeps sales in your browser's storage, so a sale created in another browser will not show here."
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <ButtonLink href="/sales">All sales</ButtonLink>
            {/* Judge mode runs on the simulated chain only. */}
            {!isNearMode() && (
              <ButtonLink href="/judge" variant="ghost">
                Run the demo
              </ButtonLink>
            )}
          </div>
        }
      />
    </div>
  );
}

function SaleLoaded({ sale }: { sale: Sale }) {
  const { account } = useWallet();
  const myBid = useMyBid(sale.id, account);
  const balances = useBalances(account);
  const funding = useLatestFunding(account, sale.id);
  const usdc = balances.data?.usdc ?? null;
  // Once a bid is on its way, keep the form mounted even if the window closes
  // meanwhile, so a late rejection is shown instead of vanishing.
  const [bidSent, setBidSent] = useState(false);

  // After settlement, the bidder's fill feeds Where's my money.
  const done = sale.status === "settled" || sale.status === "failed";
  const result = useClientQuery(
    () => (done ? getClient().getResult(sale.id) : Promise.resolve(null)),
    [sale.id, done],
    0,
  );
  const fill =
    result.data && account ? (effectiveFills(result.data).find((f) => f.bidder === account) ?? null) : null;

  return (
    <div>
      <DocumentTitle title={sale.config.tokenName} />
      {/* The status panel carries the page's one "simulated" line, so the header does not. */}
      <SaleHeader sale={sale} simulatedNote={false} />

      {/*
        Desktop: the main column (status, bid form, then the bids and the log)
        and a 340px side column (my bid, funding, where's my money, rules).
        Phones: one column, with the side cards right after the bid form.
        SaleSkeleton mirrors this grid.
      */}
      <div className="mt-5 grid gap-4 sm:mt-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[auto_1fr] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
          <StatusPanel sale={sale} account={account} hasBid={!!myBid.data} myBid={myBid.data ?? null} />
          {(sale.status === "open" || bidSent) && (
            <BidForm
              sale={sale}
              account={account}
              myBid={myBid.data}
              myBidLoading={myBid.loading}
              usdcBalance={usdc}
              onSend={() => setBidSent(true)}
            />
          )}
        </div>

        <aside
          className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1"
          aria-label="Your funds and the rules"
        >
          {account && <MyBidCard sale={sale} account={account} bid={myBid.data} loading={myBid.loading} />}
          {(sale.status === "open" || sale.status === "upcoming") && (
            <FundPanel sale={sale} account={account} hasBid={!!myBid.data} />
          )}
          <WheresMyMoney
            sale={sale}
            account={account}
            bid={myBid.data ?? null}
            fill={fill}
            funding={funding}
            usdcBalance={usdc}
          />
          <RulesPanel sale={sale} />
        </aside>

        <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-2">
          <BidTable sale={sale} account={account} />
          {/* Once closed: anyone can recompute the frozen bid set and find a bid in it. */}
          {sale.bidSetHash !== null && <BidSetPanel sale={sale} />}
          <EventLog saleId={sale.id} />
        </div>
      </div>
    </div>
  );
}
