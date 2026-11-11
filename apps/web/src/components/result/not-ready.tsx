"use client";

import { ButtonLink } from "@/components/ui/button";
import { Countdown } from "@/components/ui/bits";
import { duration } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { Sale } from "@/lib/types";

/**
 * Shown when the sale has no result yet, in the same frame as a result: where
 * the sale is, the time that matters, one sentence, and the way back to it.
 */
export function NotReady({ sale }: { sale: Sale }) {
  const now = useNow(1000);
  const c = sale.config;
  let label = "Sale in progress";
  let value: React.ReactNode = null;
  let body: React.ReactNode = "The result appears here once the sale has settled.";
  let action = "Go to the sale";

  switch (sale.status) {
    case "upcoming":
      label = "Bidding opens in";
      value = <Countdown to={c.bidStart} />;
      body = "The clearing price and every fill appear here after the bid window closes and the sealed bids are cleared.";
      action = "View the sale";
      break;
    case "open":
      label = "Bidding closes in";
      value = <Countdown to={c.bidEnd} />;
      body = "Nobody can see a price until the window closes. The result appears here after clearing.";
      action = "Place a sealed bid";
      break;
    case "awaiting_close":
      label = "Bid window ended";
      value = `${duration(now - c.bidEnd)} ago`;
      body = "Anyone can close the sale from the sale page. That freezes the bids and sends them to the enclave to clear.";
      action = "Close the sale";
      break;
    case "clearing": {
      const closed = sale.closedAt ?? now;
      const due = closed + c.settleTimeoutMs;
      if (now >= due) {
        label = "Settle timeout passed";
        value = `${duration(now - due)} ago`;
        body =
          "No clearing result has arrived. Anyone can now move the sale to refunds from the sale page, and every deposit then comes back in full.";
      } else {
        label = "Clearing for";
        value = duration(now - closed);
        body = (
          <>
            The bids are frozen and the enclave is opening them. Results usually land within two minutes. If none
            arrives in <Countdown to={due} className="text-fg" />, anyone can switch the sale to refunds.
          </>
        );
        action = "Follow the clearing";
      }
      break;
    }
    case "revealing": {
      const end = sale.revealEnd ?? null;
      if (end !== null && now < end) {
        label = "Reveal window closes in";
        value = <Countdown to={end} />;
      } else if (end !== null) {
        label = "Reveal window ended";
        value = `${duration(now - end)} ago`;
      } else {
        label = "Reveal window open for";
        value = duration(now - (sale.closedAt ?? c.bidEnd));
      }
      body =
        "Bidders reveal their bids on the sale page. Once the window has ended, anyone can have the contract clear the sale, and the result appears here.";
      action = "Open the reveal";
      break;
    }
  }

  return (
    <section className="panel p-5 sm:p-8" aria-labelledby="not-ready-title">
      <h2 id="not-ready-title" className="text-label text-subtle">
        {label}
      </h2>
      {value !== null && (
        <div className="num mt-2 text-num-hero text-fg" suppressHydrationWarning>
          {value}
        </div>
      )}
      <p className="mt-5 max-w-[56ch] text-body text-muted">
        <span className="text-fg">No result yet.</span> {body}
      </p>
      <ButtonLink href={`/sale/${sale.id}`} variant="primary" size="lg" className="mt-6">
        {action}
      </ButtonLink>
    </section>
  );
}
