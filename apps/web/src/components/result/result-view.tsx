"use client";

import { use, useMemo } from "react";
import { RotateCw } from "lucide-react";
import { EventLog } from "@/components/sale-common/event-log";
import { WheresMyMoney } from "@/components/sale-common/wheres-my-money";
import { SaleNotFound } from "@/components/sale/sale-page";
import { SimulatedNote } from "@/components/ui/bits";
import { Button, ButtonLink } from "@/components/ui/button";
import { Empty } from "@/components/ui/panel";
import { Reveal } from "@/components/visual/reveal";
import { isNearMode } from "@/lib/config";
import { useLatestFunding } from "@/lib/funding";
import { DocumentTitle, useBalances, useBids, useMyBid, useResult, useSale } from "@/lib/hooks";
import type { Sale, SaleResult } from "@/lib/types";
import { useWallet } from "@/lib/wallet";
import { effectiveFills } from "./compute";
import { Distribution } from "./distribution";
import { FairnessTimeline } from "./fairness-timeline";
import { FillsTable } from "./fills-table";
import { MyResult } from "./my-result";
import { NotReady } from "./not-ready";
import { OutcomeHero } from "./outcome-hero";
import { PoolPanel } from "./pool-panel";
import { ResultHeader } from "./result-header";
import { OutcomeReveal } from "./reveal";
import { SamePrice } from "./same-price";
import { ShareOnX } from "./share";
import { ResultSkeleton } from "./skeleton";
import { SupplyStory } from "./supply-panel";
import { buildTimeline } from "./timeline";
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

/** The page's one "simulated" disclosure. Blocks below carry at most a tag. */
function Simulated() {
  if (isNearMode()) return null;
  return (
    <SimulatedNote>
      Simulated chain, accounts and enclave, in your browser. Bid encryption and the clearing math are real.
    </SimulatedNote>
  );
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
          <ButtonLink href="/sales" size="sm">
            All sales
          </ButtonLink>
        }
      />
    );
  }

  if (!sale.data) return <SaleNotFound id={id} />;

  const s = sale.data;
  const done = s.status === "settled" || s.status === "failed";

  return (
    <div className="flex w-full flex-col gap-10 sm:gap-14">
      <DocumentTitle title={`${s.config.tokenName} result`} />
      {done && result.data ? (
        <Outcome sale={s} result={result.data} />
      ) : (
        <div className="flex flex-col gap-5 sm:gap-6">
          <ResultHeader sale={s} />
          <div className="flex flex-col gap-4">
            {!done ? (
              <NotReady sale={s} />
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
            <Simulated />
          </div>
        </div>
      )}
    </div>
  );
}

function Outcome({ sale, result }: { sale: Sale; result: SaleResult }) {
  const { account } = useWallet();
  // Stable while the result is unchanged, so the table and chart do not redo work.
  const fills = useMemo(() => effectiveFills(result), [result]);
  const myFill = account ? (fills.find((f) => f.bidder === account) ?? null) : null;
  const myBid = useMyBid(sale.id, account);
  const balances = useBalances(account);
  const funding = useLatestFunding(account, sale.id);
  // Public bids, for when each landed (the timeline, the reveal and the share text). Never their prices.
  const bids = useBids(sale.id);
  const timeline = useMemo(
    () => (bids.data ? buildTimeline(sale, result, fills, bids.data, account) : null),
    [sale, result, fills, bids.data, account],
  );

  return (
    <>
      <div className="flex flex-col gap-5 sm:gap-6">
        <ResultHeader sale={sale} action={<ShareOnX sale={sale} result={result} timeline={timeline} />} />
        <div className="flex flex-col gap-4">
          <OutcomeHero
            sale={sale}
            result={result}
            fills={fills}
            aside={<MyResult sale={sale} result={result} fill={myFill} />}
            reveal={<OutcomeReveal sale={sale} result={result} fills={fills} bids={bids.data ?? null} />}
          />
          <Simulated />
        </div>
      </div>

      {fills.length > 0 && (
        <Reveal>
          <FairnessTimeline
            sale={sale}
            result={result}
            timeline={timeline}
            loading={bids.loading}
            error={bids.error?.message ?? null}
            onRetry={bids.refetch}
          />
        </Reveal>
      )}

      {result.status === "settled" && (
        <Reveal>
          <SamePrice sale={sale} result={result} fills={fills} />
        </Reveal>
      )}

      <Reveal>
        <SupplyStory sale={sale} result={result} />
      </Reveal>

      {result.liquidity && <PoolPanel sale={sale} result={result} />}

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

      <div className="flex flex-col gap-4">
        <FillsTable sale={sale} fills={fills} account={account} />
        {fills.some((f) => f.tokens > 0n) ? (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Distribution sale={sale} fills={fills} account={account} />
            <EventLog saleId={sale.id} title="History" />
          </div>
        ) : (
          // Nobody got tokens (a failed sale), so there is no distribution to chart.
          <EventLog saleId={sale.id} title="History" />
        )}
      </div>
    </>
  );
}
