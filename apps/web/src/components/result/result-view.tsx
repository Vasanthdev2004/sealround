"use client";

import { use } from "react";
import { EventLog } from "@/components/sale-common/event-log";
import { SaleHeader } from "@/components/sale-common/sale-header";
import { WheresMyMoney } from "@/components/sale-common/wheres-my-money";
import { RotateCw } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Empty } from "@/components/ui/panel";
import { useLatestFunding } from "@/lib/funding";
import { useBalances, useMyBid, useResult, useSale } from "@/lib/hooks";
import type { Sale, SaleResult } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { effectiveFills } from "./compute";
import { Distribution } from "./distribution";
import { FillsTable } from "./fills-table";
import { MyResult } from "./my-result";
import { NotReady } from "./not-ready";
import { OutcomeHero } from "./outcome-hero";
import { SamePrice } from "./same-price";
import { ResultSkeleton } from "./skeleton";
import { VerifiedPanel } from "./verified-panel";

/** Client entry for /sale/[id]/result. Unwraps the params promise. */
export function ResultView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ResultPage id={safeDecode(id)} />;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function ResultPage({ id }: { id: string }) {
  const sale = useSale(id);
  const result = useResult(id);

  if (sale.loading || (sale.data && result.loading)) return <ResultSkeleton />;

  if (sale.error) {
    return (
      <Empty
        title="Could not load this sale"
        body={sale.error.message}
        action={
          <ButtonLink href="/" size="sm">
            All sales
          </ButtonLink>
        }
      />
    );
  }

  if (!sale.data) {
    return (
      <Empty
        title="Sale not found"
        body={
          <>
            There is no sale with the id <span className="num text-fg">{id}</span>.
          </>
        }
        action={
          <ButtonLink href="/" size="sm">
            All sales
          </ButtonLink>
        }
      />
    );
  }

  const s = sale.data;
  const done = s.status === "settled" || s.status === "failed";

  return (
    <div className="mx-auto max-w-[1080px] space-y-6">
      <SaleHeader sale={s} back={{ href: `/sale/${s.id}`, label: "Back to sale" }} />
      {!done ? (
        <NotReady sale={s} />
      ) : result.data ? (
        <Outcome sale={s} result={result.data} />
      ) : (
        // Settled or refunding, but the result did not load: say so, never guess an outcome.
        <Empty
          className="py-14"
          title="Could not load the result"
          body={
            result.error
              ? `The sale has finished, but reading its result failed: ${result.error.message}`
              : "The sale has finished, but no result is stored for it yet."
          }
          action={
            <Button size="sm" onClick={result.refetch} icon={<RotateCw className="size-3.5" />}>
              Try again
            </Button>
          }
        />
      )}
    </div>
  );
}

function Outcome({ sale, result }: { sale: Sale; result: SaleResult }) {
  const { account } = useWallet();
  const fills = effectiveFills(result);
  const myFill = account ? (fills.find((f) => f.bidder === account) ?? null) : null;
  const myBid = useMyBid(sale.id, account);
  const balances = useBalances(account);
  const funding = useLatestFunding(account, sale.id);

  return (
    <>
      <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <OutcomeHero sale={sale} result={result} fills={fills} />
        <MyResult sale={sale} result={result} fill={myFill} />
      </div>

      {result.status === "settled" && <SamePrice sale={sale} result={result} fills={fills} />}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <VerifiedPanel sale={sale} result={result} />
        <WheresMyMoney
          sale={sale}
          account={account}
          bid={myBid.data ?? null}
          fill={myFill}
          funding={funding}
          usdcBalance={balances.data?.usdc ?? null}
        />
      </div>

      <FillsTable sale={sale} fills={fills} account={account} />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Distribution sale={sale} fills={fills} account={account} />
        <EventLog saleId={sale.id} limit={20} title="History" />
      </div>
    </>
  );
}
