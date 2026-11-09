"use client";

import { use, useState } from "react";
import { effectiveFills } from "@/components/result/compute";
import { EventLog } from "@/components/sale-common/event-log";
import { SaleHeader } from "@/components/sale-common/sale-header";
import { WheresMyMoney } from "@/components/sale-common/wheres-my-money";
import { ButtonLink } from "@/components/ui/button";
import { Empty } from "@/components/ui/panel";
import { useLatestFunding } from "@/lib/funding";
import { getClient } from "@/lib/client";
import { useBalances, useClientQuery, useMyBid, useSale } from "@/lib/hooks";
import type { Sale } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { BidForm } from "./bid-form";
import { BidTable } from "./bid-table";
import { FundPanel } from "./fund-panel";
import { MyBidCard } from "./my-bid-card";
import { PublicStats } from "./public-stats";
import { RulesPanel } from "./rules-panel";
import { SaleSkeleton } from "./sale-skeleton";
import { StatusPanel } from "./status-panel";

export function SalePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sale = useSale(id);

  if (sale.loading) return <SaleSkeleton />;
  if (sale.error && !sale.data) {
    return (
      <div className="mx-auto max-w-[1180px]">
        <Empty
          title="Could not load this sale"
          body={sale.error.message}
          action={
            <ButtonLink href="/" size="sm">
              All sales
            </ButtonLink>
          }
        />
      </div>
    );
  }
  if (!sale.data) return <SaleNotFound id={id} />;
  return <SaleLoaded key={sale.data.id} sale={sale.data} />;
}

function SaleNotFound({ id }: { id: string }) {
  return (
    <div className="mx-auto max-w-[1180px] py-10">
      <Empty
        title={
          <>
            No sale called <span className="num">{id}</span>
          </>
        }
        body="This demo keeps sales in your browser's storage, so a sale created in another browser will not show here. Check the link or pick a sale from the list."
        action={
          <ButtonLink href="/" size="sm">
            All sales
          </ButtonLink>
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
    <div className="mx-auto max-w-[1180px]">
      <SaleHeader sale={sale} />

      {/*
        Desktop: main column (status, stats, bid form, then bids and log) and a
        side column (my bid, fund, where's my money, rules).
        Mobile: one column, with the side panels right after the bid form.
      */}
      <div className="mt-7 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:grid-rows-[auto_1fr]">
        <div className="min-w-0 space-y-6 xl:col-start-1 xl:row-start-1">
          <StatusPanel sale={sale} account={account} />
          <PublicStats sale={sale} />
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

        <aside className="min-w-0 space-y-6 xl:col-start-2 xl:row-span-2 xl:row-start-1">
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

        <div className="min-w-0 space-y-6 xl:col-start-1 xl:row-start-2">
          <BidTable sale={sale} account={account} />
          <EventLog saleId={sale.id} />
        </div>
      </div>
    </div>
  );
}
