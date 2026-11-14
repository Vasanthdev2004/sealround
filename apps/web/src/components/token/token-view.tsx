"use client";

import { use, useMemo } from "react";
import Link from "next/link";
import { RotateCw } from "lucide-react";
import { BurnLine } from "@/components/burn/burn-line";
import { effectiveFills, failText } from "@/components/result/compute";
import { SupplyStory } from "@/components/result/supply-panel";
import { buildTimeline } from "@/components/result/timeline";
import { useTokenSupply } from "@/components/result/use-token-supply";
import { SaleNotFound } from "@/components/sale/sale-page";
import { SaleStatusBadge } from "@/components/ui/badge";
import { Countdown, SimulatedNote } from "@/components/ui/bits";
import { Button, ButtonLink } from "@/components/ui/button";
import { Empty } from "@/components/ui/panel";
import { Reveal } from "@/components/visual/reveal";
import { isNearMode } from "@/lib/config";
import { DocumentTitle, useBids, useResult, useSale } from "@/lib/hooks";
import { supplyFigure } from "@/lib/near/token-supply";
import type { Sale, SaleResult } from "@/lib/types";
import { holdersOf, tokenFigures } from "./figures";
import { LaunchPanel } from "./launch-panel";
import { LaunchProof } from "./launch-proof";
import { ShareToken } from "./share-token";
import { TokenHeader } from "./token-header";
import { TokenSkeleton } from "./token-skeleton";

/** Client entry for /token/[id] (the id is the sale's). Unwraps the params promise. */
export function TokenView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <TokenPage id={safeDecode(id)} />;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const inline = "text-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-fg";

/** The page's one "simulated" disclosure. */
function Simulated() {
  if (isNearMode()) return null;
  return (
    <SimulatedNote>
      Simulated chain, accounts, pool and enclave, in your browser. Bid encryption and the clearing math are real.
    </SimulatedNote>
  );
}

function TokenPage({ id }: { id: string }) {
  const sale = useSale(id);
  const result = useResult(id);

  if (sale.loading || (sale.data && result.loading)) return <TokenSkeleton />;

  if (sale.error) {
    return (
      <Empty
        title="Could not load this token"
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
  const resultHref = `/sale/${encodeURIComponent(s.id)}/result`;

  if (s.status !== "settled" && s.status !== "failed") return <NotLaunched sale={s} />;

  if (!result.data) {
    // Final, but the result did not load: say so, never guess the figures.
    return (
      <Frame sale={s} line={<Launched href={resultHref} />}>
        <Empty
          className="py-14"
          title="Could not load the launch"
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
      </Frame>
    );
  }

  if (result.data.status === "failed") return <NoToken sale={s} result={result.data} />;
  return <TokenHome sale={s} result={result.data} />;
}

function Launched({ href }: { href: string }) {
  return (
    <>
      Launched on Sealround in a{" "}
      <Link href={href} className={inline}>
        sealed-bid sale
      </Link>
    </>
  );
}

/** The header, then the page's first block with the simulated note under it. */
function Frame({
  sale,
  line,
  action,
  children,
}: {
  sale: Sale;
  line: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* "$SYM on Sealround", as the server metadata says in NEAR mode. */}
      <DocumentTitle full={`$${sale.config.tokenSymbol} on Sealround`} />
      <TokenHeader sale={sale} line={line} action={action} />
      <div className="flex flex-col gap-4">
        {children}
        <Simulated />
      </div>
    </div>
  );
}

function TokenHome({ sale, result }: { sale: Sale; result: SaleResult }) {
  // Stable while the result is unchanged, so the timeline does not redo work.
  const fills = useMemo(() => effectiveFills(result), [result]);
  const holders = holdersOf(fills);
  // On NEAR the supply now is the token's own ft_total_supply, holders' burns included.
  const supplyNow = useTokenSupply(sale).data;
  const figures = useMemo(() => {
    const f = tokenFigures(sale, result, holders);
    return { ...f, supply: supplyFigure(f.supply, supplyNow) };
  }, [sale, result, holders, supplyNow]);
  // Public bids, only for when each landed (the headline). Never their prices.
  const bids = useBids(sale.id);
  const timeline = useMemo(
    () => (bids.data ? buildTimeline(sale, result, fills, bids.data) : null),
    [sale, result, fills, bids.data],
  );

  return (
    <div className="flex w-full flex-col gap-10 sm:gap-14">
      <Frame
        sale={sale}
        line={<Launched href={`/sale/${encodeURIComponent(sale.id)}/result`} />}
        action={<ShareToken sale={sale} result={result} figures={figures} />}
      >
        <LaunchPanel sale={sale} result={result} figures={figures} />
        <BurnLine sale={sale} result={result} />
      </Frame>

      <Reveal>
        <SupplyStory sale={sale} result={result} hideNoPool />
      </Reveal>

      <Reveal>
        <LaunchProof sale={sale} result={result} holders={holders} timeline={timeline} />
      </Reveal>
    </div>
  );
}

/** The sale has not settled: no price exists yet. */
function NotLaunched({ sale }: { sale: Sale }) {
  const c = sale.config;
  const href = `/sale/${encodeURIComponent(sale.id)}`;
  const timer =
    sale.status === "upcoming" ? (
      <>
        Bidding opens in <Countdown to={c.bidStart} className="text-fg" />
      </>
    ) : sale.status === "open" ? (
      <>
        Bidding closes in <Countdown to={c.bidEnd} className="text-fg" />
      </>
    ) : null;

  return (
    <Frame
      sale={sale}
      line={
        <>
          Launches on Sealround in a{" "}
          <Link href={href} className={inline}>
            sealed-bid sale
          </Link>
        </>
      }
    >
      <section className="panel p-5 sm:p-8" aria-labelledby="not-launched-title">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <SaleStatusBadge status={sale.status} />
          {timer && (
            <span className="num text-small text-muted" suppressHydrationWarning>
              {timer}
            </span>
          )}
        </div>
        <h2 id="not-launched-title" className="mt-4 text-h2 break-words text-fg">
          ${c.tokenSymbol} launches when sale <span className="num">{sale.id}</span> settles
        </h2>
        <p className="mt-3 max-w-[56ch] text-body text-muted">
          Bids stay sealed until the sale closes, so there is no price yet. Once it settles, this page shows the price every
          winner paid, the supply after the burn and where {c.tokenSymbol} trades.
        </p>
        <ButtonLink href={href} variant="primary" size="lg" className="mt-6">
          Go to the sale
        </ButtonLink>
      </section>
    </Frame>
  );
}

/** The sale failed: nothing was sold, so there is nothing to trade. */
function NoToken({ sale, result }: { sale: Sale; result: SaleResult }) {
  const c = sale.config;
  const href = `/sale/${encodeURIComponent(sale.id)}/result`;
  const { title } = failText(result, sale);

  return (
    <Frame
      sale={sale}
      line={
        <>
          Its Sealround{" "}
          <Link href={href} className={inline}>
            sealed-bid sale
          </Link>{" "}
          did not clear
        </>
      }
    >
      <section className="panel p-5 sm:p-8" aria-labelledby="no-token-title">
        <div className="text-label text-subtle">{title}</div>
        <h2 id="no-token-title" className="mt-2 text-h2 text-fg">
          No {c.tokenSymbol} to trade
        </h2>
        <p className="mt-3 max-w-[56ch] text-body text-muted">
          The sale did not clear, so no {c.tokenSymbol} was sold and every valid bid gets its whole deposit back.
        </p>
        <ButtonLink href={href} variant="primary" size="lg" className="mt-6">
          See the result
        </ButtonLink>
      </section>
    </Frame>
  );
}
